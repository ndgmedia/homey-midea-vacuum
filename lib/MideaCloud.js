'use strict';

const crypto = require('crypto');
const https = require('https');

const API_URL = 'https://mp-prod.appsmb.com/mas/v5/app/proxy?alias=';
const APP_ID = '1010';
const APP_KEY = 'ac21b9f9cbfe4ca5a88562ef25e2b768';
const IOT_KEY = 'meicloud';
const HMAC_KEY = 'PROD_VnoClJI9aikS8dyy';

class MideaCloud {
  /**
   * @param {string} email - MSmartHome account email
   * @param {string} password - MSmartHome account password
   * @param {Function} log - Logger function
   */
  constructor(email, password, log) {
    this.email = email;
    this.password = password;
    this.log = log || console.log;

    // Generated from email
    this._deviceId = crypto
      .createHash('sha256')
      .update(`Hello, ${email}!`, 'ascii')
      .digest('hex')
      .slice(0, 16);

    this._uid = null;
    this._accessToken = null; // short token for headers
    this._loginId = null;
    this._apiUrl = API_URL;
    this._lastRequestTime = 0;
  }

  /**
   * Full login flow: re-route → get login ID → login
   */
  async login() {
    // Step 1: Re-route (get regional API URL)
    await this._reRoute();

    // Step 2: Get login ID (needed for password hashing)
    this._loginId = await this._getLoginId();
    if (!this._loginId) {
      throw new Error('Failed to get login ID');
    }

    // Step 3: Login
    const stamp = this._formatStamp();
    const iotData = {
      ...this._makeGeneralData(),
      iampwd: this._encryptIamPassword(this._loginId, this.password),
      loginAccount: this.email,
      password: this._encryptPassword(this._loginId, this.password),
      stamp,
    };
    delete iotData.uid;

    const data = {
      iotData,
      data: {
        appKey: APP_KEY,
        deviceId: this._deviceId,
        platform: '2',
      },
      stamp,
    };

    const response = await this._apiRequest('/mj/user/login', data);
    if (!response) {
      throw new Error('Login failed: no response');
    }

    this._uid = response.uid;
    this._accessToken = response.mdata.accessToken;

    this.log('Cloud login successful, uid:', this._uid);
  }

  /**
   * List appliances from the cloud, optionally filtered by type.
   * @param {number} [typeFilter] - Device type to filter (e.g. 0xB8 for vacuum)
   * @returns {Array<{id: string, name: string, type: number, model: string, online: boolean}>}
   */
  async listAppliances(typeFilter) {
    const data = this._makeGeneralData();
    const response = await this._apiRequest('/v1/appliance/user/list/get', data);
    if (!response || !response.list) {
      return [];
    }

    const appliances = response.list.map((a) => ({
      id: String(a.id),
      name: a.name || 'Unknown',
      type: parseInt(a.type, 16),
      model: a.productModel || '',
      online: a.onlineStatus === '1',
    }));

    if (typeFilter !== undefined) {
      return appliances.filter((a) => a.type === typeFilter);
    }
    return appliances;
  }

  /**
   * Query device status via Lua cloud API.
   * @param {string} applianceId - Appliance ID
   * @returns {object|null} Status object with device attributes, or null on failure
   */
  async queryStatus(applianceId) {
    const data = this._makeGeneralData();
    data.applianceCode = String(applianceId);
    data.command = { query: {} };

    try {
      const response = await this._apiRequest('/v1/device/status/lua/get', data);
      return response || null;
    } catch (err) {
      // Token expiry — caller should re-login
      if (err.message && err.message.includes('40002')) {
        throw err;
      }
      this.log('[queryStatus] Error:', err.message);
      return null;
    }
  }

  /**
   * Send a control command via Lua cloud API.
   * IMPORTANT: control must always include work_status — other fields (fan_level, etc.)
   * cannot be sent standalone.
   * @param {string} applianceId - Appliance ID
   * @param {object} control - Control fields (e.g. { work_status: 'work', fan_level: 'high' })
   * @param {object} [currentStatus] - Current device state (from last queryStatus)
   * @returns {object|null} Response data, or null on failure
   */
  async sendControl(applianceId, control, currentStatus) {
    // Build cleaned status (remove metadata fields the Lua script doesn't want)
    const status = {};
    if (currentStatus) {
      for (const [k, v] of Object.entries(currentStatus)) {
        if (k !== 'sn8' && k !== 'version' && k !== 'query_type') {
          status[k] = v;
        }
      }
    }

    const data = this._makeGeneralData();
    data.applianceCode = String(applianceId);
    data.command = { control, status };

    return this._apiRequest('/v1/device/lua/control', data, 15000);
  }

  // --- Re-route ---

  async _reRoute() {
    const data = this._makeGeneralData();
    data.userType = '0';
    data.userName = this.email;
    try {
      const response = await this._apiRequest(
        '/v1/multicloud/platform/user/route',
        data,
      );
      if (response && response.masUrl) {
        this._apiUrl = response.masUrl;
        this.log('Re-routed to:', this._apiUrl);
      }
    } catch {
      // Re-route failure is non-fatal, continue with default URL
    }
  }

  // --- Get login ID ---

  async _getLoginId() {
    const data = this._makeGeneralData();
    data.loginAccount = this.email;
    const response = await this._apiRequest('/v1/user/login/id/get', data);
    return response ? response.loginId : null;
  }

  // --- Password hashing ---

  _encryptPassword(loginId, password) {
    const pwdHash = crypto.createHash('sha256').update(password, 'ascii').digest('hex');
    const loginHash = loginId + pwdHash + APP_KEY;
    return crypto.createHash('sha256').update(loginHash, 'ascii').digest('hex');
  }

  _encryptIamPassword(loginId, password) {
    const md5First = crypto.createHash('md5').update(password, 'ascii').digest('hex');
    const md5Second = crypto.createHash('md5').update(md5First, 'ascii').digest('hex');
    const loginHash = loginId + md5Second + APP_KEY;
    return crypto.createHash('sha256').update(loginHash, 'ascii').digest('hex');
  }

  // --- General request data ---

  _makeGeneralData() {
    return {
      src: APP_ID,
      format: '2',
      stamp: this._formatStamp(),
      platformId: '1',
      deviceId: this._deviceId,
      reqId: crypto.randomBytes(16).toString('hex'),
      uid: this._uid,
      clientType: '1',
      appId: APP_ID,
      language: 'en_US',
    };
  }

  _formatStamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return (
      `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
      `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
    );
  }

  // --- Request signing & HTTP ---

  _signRequest(jsonBody) {
    const random = String(Math.floor(Date.now() / 1000));
    const msg = IOT_KEY + jsonBody + random;
    const sign = crypto
      .createHmac('sha256', HMAC_KEY)
      .update(msg, 'ascii')
      .digest('hex');
    return { sign, random };
  }

  async _apiRequest(endpoint, data, timeout = 8000) {
    // Throttle: minimum 200ms between requests to avoid token invalidation
    const now = Date.now();
    const elapsed = now - this._lastRequestTime;
    if (elapsed < 200) {
      await new Promise((resolve) => { setTimeout(resolve, 200 - elapsed); });
    }
    this._lastRequestTime = Date.now();

    const jsonBody = JSON.stringify(data);
    const { sign, random } = this._signRequest(jsonBody);

    const authBase = Buffer.from(`${APP_KEY}:${IOT_KEY}`, 'ascii').toString('base64');

    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'secretVersion': '1',
      'sign': sign,
      'random': random,
      'x-recipe-app': APP_ID,
      'authorization': `Basic ${authBase}`,
    };
    if (this._uid) headers.uid = this._uid;
    if (this._accessToken) headers.accesstoken = this._accessToken;

    const url = new URL(this._apiUrl + endpoint);
    this.log(`[_apiRequest] ${endpoint} timeout=${timeout}ms`);

    const responseBody = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: 'POST',
          headers,
          timeout,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(new Error(`Invalid JSON response: ${e.message}`));
            }
          });
        },
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.on('error', reject);
      req.write(jsonBody);
      req.end();
    });

    this.log(`[_apiRequest] ${endpoint} response code=${responseBody.code}, msg=${responseBody.msg || 'ok'}`);

    if (responseBody.code !== undefined && parseInt(responseBody.code) !== 0) {
      const code = parseInt(responseBody.code);
      this.log(`[_apiRequest] ${endpoint} API error code=${code}, msg=${responseBody.msg || 'unknown'}`);
      if (code === 1306) {
        this.log(`[_apiRequest] Async reply timeout (1306) — command likely delivered`);
        return null;
      }
      if (code === 3176) {
        throw new Error(`3176: Device sleeping / async reply does not exist`);
      }
      if (code === 40002) {
        throw new Error(`40002: Token expired — re-login needed`);
      }
      if (code === 65027) {
        throw new Error(`65027: Rate limited - too many login attempts`);
      }
      throw new Error(
        `API error ${responseBody.code}: ${responseBody.msg || 'unknown'}`,
      );
    }

    return responseBody.data || null;
  }
}

module.exports = MideaCloud;

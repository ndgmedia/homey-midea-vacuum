'use strict';

const Homey = require('homey');
const MideaCloud = require('../../lib/MideaCloud');

const POLL_INTERVAL_MS = 30000;

// Cloud work_status → Homey vacuumcleaner_state
const WORK_STATUS_TO_HOMEY = {
  work: 'cleaning',
  auto_clean: 'cleaning',
  charging_on_dock: 'docked',
  on_base: 'docked',
  charge_finish: 'docked',
  stop: 'stopped',
  sleep: 'stopped',
  clean_pause: 'stopped',
  charge_pause: 'stopped',
  charging: 'charging',
  charge: 'charging',
  error: 'stopped',
};

// Cloud fan_level ↔ Homey fan_speed
const FAN_TO_HOMEY = { soft: 'quiet', normal: 'normal', high: 'strong' };
const HOMEY_TO_FAN = { quiet: 'soft', normal: 'normal', strong: 'high' };

// Cloud water_level ↔ Homey water_level
const WATER_TO_HOMEY = { low: 'low', normal: 'medium', high: 'high' };
const HOMEY_TO_WATER = { low: 'low', medium: 'normal', high: 'high' };

class MideaVacuumDevice extends Homey.Device {
  async onInit() {
    this.log('Midea Vacuum device init:', this.getName());

    const settings = this.getSettings();
    this.cloud = new MideaCloud(settings.email, settings.password, this.log.bind(this));
    this.applianceId = this.getStoreValue('applianceId');

    // Cache last known device status for control commands
    this._lastStatus = null;

    try {
      await this.cloud.login();
      await this.setAvailable();
    } catch (err) {
      this.error('Cloud login failed:', err.message);
      await this.setUnavailable('Cloud login failed. Check credentials.');
      return;
    }

    this._registerCapabilityListeners();

    // Start polling
    this.pollInterval = this.homey.setInterval(() => {
      this._pollStatus().catch((err) => this.error('Poll error:', err.message));
    }, POLL_INTERVAL_MS);

    // Initial poll
    await this._pollStatus().catch((err) => this.error('Initial poll error:', err.message));
  }

  /**
   * Send a control command with fresh status query and automatic token re-auth.
   * Querying status first ensures the device is awake and the status payload is current.
   */
  async _sendControlWithRetry(control) {
    try {
      // Always fetch fresh status before control — wakes device and ensures current state
      const freshStatus = await this.cloud.queryStatus(this.applianceId);
      if (freshStatus) {
        this._lastStatus = freshStatus;
      }
      return await this.cloud.sendControl(this.applianceId, control, this._lastStatus);
    } catch (err) {
      if (err.message && err.message.includes('40002')) {
        this.log('Token expired during control, re-logging in...');
        await this.cloud.login();
        const freshStatus = await this.cloud.queryStatus(this.applianceId);
        if (freshStatus) {
          this._lastStatus = freshStatus;
        }
        return await this.cloud.sendControl(this.applianceId, control, this._lastStatus);
      }
      throw err;
    }
  }

  _registerCapabilityListeners() {
    // Vacuum state control
    this.registerCapabilityListener('vacuumcleaner_state', async (value) => {
      this.log(`[vacuumcleaner_state] Setting to: ${value}`);

      const control = {};

      switch (value) {
        case 'cleaning': {
          control.work_status = 'work';
          // Include current fan level when starting
          const fanSpeed = this.getCapabilityValue('fan_speed');
          if (fanSpeed && HOMEY_TO_FAN[fanSpeed]) {
            control.fan_level = HOMEY_TO_FAN[fanSpeed];
          }
          break;
        }
        case 'stopped':
          control.work_status = 'stop';
          break;
        case 'docked':
        case 'charging':
          control.work_status = 'charge';
          break;
        default:
          throw new Error(`Unknown state: ${value}`);
      }

      await this._sendControlWithRetry(control);
      this.log('[vacuumcleaner_state] Command sent');
    });

    // Fan speed — must be combined with work_status, so we re-send "work" if currently cleaning
    this.registerCapabilityListener('fan_speed', async (value) => {
      this.log(`[fan_speed] Setting to: ${value}`);
      const fanLevel = HOMEY_TO_FAN[value];
      if (!fanLevel) throw new Error(`Unknown fan speed: ${value}`);

      const currentState = this.getCapabilityValue('vacuumcleaner_state');
      if (currentState === 'cleaning') {
        // Currently cleaning — send work + new fan level
        await this._sendControlWithRetry({ work_status: 'work', fan_level: fanLevel });
        this.log('[fan_speed] Applied while cleaning');
      } else {
        // Not cleaning — will be applied on next start
        this.log('[fan_speed] Stored, will apply on next cleaning start');
      }
    });

    // Water level — same constraint as fan speed
    this.registerCapabilityListener('water_level', async (value) => {
      this.log(`[water_level] Setting to: ${value}`);
      const waterLevel = HOMEY_TO_WATER[value];
      if (!waterLevel) throw new Error(`Unknown water level: ${value}`);

      const currentState = this.getCapabilityValue('vacuumcleaner_state');
      if (currentState === 'cleaning') {
        // Currently cleaning — try to apply (may not work for all settings)
        try {
          await this._sendControlWithRetry({ work_status: 'work', water_level: waterLevel });
          this.log('[water_level] Applied while cleaning');
        } catch (err) {
          this.log('[water_level] Could not apply while cleaning:', err.message);
        }
      } else {
        this.log('[water_level] Stored, will apply on next cleaning start');
      }
    });
  }

  async _pollStatus() {
    try {
      const status = await this.cloud.queryStatus(this.applianceId);

      if (!status) {
        this.log('No status from device, skipping poll');
        return;
      }

      this.log(`[_pollStatus] Status: work_status=${status.work_status}, battery=${status.battery_percent}, fan=${status.fan_level}`);

      // Cache for control commands
      this._lastStatus = status;

      // Update capabilities in parallel
      const updates = [];

      const homeyState = WORK_STATUS_TO_HOMEY[status.work_status] || 'stopped';
      updates.push(this.setCapabilityValue('vacuumcleaner_state', homeyState));

      const battery = parseInt(status.battery_percent, 10);
      if (!isNaN(battery)) {
        updates.push(this.setCapabilityValue('measure_battery', battery));
      }

      const fanSpeed = FAN_TO_HOMEY[status.fan_level];
      if (fanSpeed) {
        updates.push(this.setCapabilityValue('fan_speed', fanSpeed));
      }

      const waterLevel = WATER_TO_HOMEY[status.water_level];
      if (waterLevel) {
        updates.push(this.setCapabilityValue('water_level', waterLevel));
      }

      const area = parseInt(status.area, 10);
      if (!isNaN(area)) {
        updates.push(this.setCapabilityValue('measure_cleaning_area', area));
      }

      await Promise.all(updates);

      if (!this.getAvailable()) {
        await this.setAvailable();
      }
    } catch (err) {
      // Token expired — re-login
      if (err.message && err.message.includes('40002')) {
        this.log('Token expired, re-logging in...');
        try {
          await this.cloud.login();
          this.log('Re-login successful');
        } catch (loginErr) {
          this.error('Re-login failed:', loginErr.message);
          await this.setUnavailable('Cloud session expired');
        }
        return;
      }

      throw err;
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('email') || changedKeys.includes('password')) {
      const newCloud = new MideaCloud(
        newSettings.email,
        newSettings.password,
        this.log.bind(this),
      );
      await newCloud.login();
      this.cloud = newCloud;
      this.log('Re-authenticated with new credentials');
    }
  }

  async onUninit() {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  onDeleted() {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}

module.exports = MideaVacuumDevice;

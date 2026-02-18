'use strict';

const Homey = require('homey');
const MideaCloud = require('../../lib/MideaCloud');

class MideaVacuumDriver extends Homey.Driver {
  async onPair(session) {
    let cloud = null;

    session.setHandler('login', async (data) => {
      cloud = new MideaCloud(data.username, data.password, this.log.bind(this));
      try {
        await cloud.login();
        return true;
      } catch (err) {
        this.error('Login failed:', err.message);
        throw err;
      }
    });

    session.setHandler('list_devices', async () => {
      if (!cloud) {
        throw new Error('Not logged in');
      }

      const vacuums = await cloud.listAppliances(0xb8);

      return vacuums.map((vac) => ({
        name: vac.name || 'Midea Vacuum',
        data: {
          id: vac.id,
        },
        store: {
          applianceId: vac.id,
          model: vac.model,
        },
        settings: {
          email: cloud.email,
          password: cloud.password,
        },
      }));
    });
  }
}

module.exports = MideaVacuumDriver;

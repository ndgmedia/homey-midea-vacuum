'use strict';

const Homey = require('homey');

class MideaVacuumApp extends Homey.App {
  async onInit() {
    this.log('Midea Vacuum app initialized');
  }
}

module.exports = MideaVacuumApp;

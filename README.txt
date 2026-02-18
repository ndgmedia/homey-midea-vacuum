Midea Vacuum for Homey
======================

Control your Midea robot vacuum cleaner from Homey using the MSmartHome cloud API.


Features
--------

- Vacuum state control - Start cleaning, stop, or send the vacuum back to the dock
- Battery monitoring - View the current battery level
- Fan speed - Switch between Quiet, Normal, and Strong suction modes
- Water level - Set mopping water flow to Low, Medium, or High
- Cleaning area - See how many m² have been cleaned


Supported devices
-----------------

This app supports Midea robot vacuum cleaners (device type 0xB8) that are registered
in the MSmartHome app. This includes vacuums sold under the Midea brand as well as
various OEM/white-label brands that use the MSmartHome platform.


Setup
-----

1. Install the app on your Homey
2. Add a new device and select "Midea Vacuum"
3. Log in with your MSmartHome account credentials (email and password)
4. Select your vacuum from the list of discovered devices

Note: Your MSmartHome credentials are stored locally on your Homey and are only used
to authenticate with the Midea cloud API.


How it works
------------

The app communicates with the Midea MSmartHome cloud API to control your vacuum.
It polls the device status every 30 seconds to keep Homey in sync. There is no
local/LAN communication - an active internet connection is required.


Capabilities
------------

vacuumcleaner_state   Cleaning, Stopped, Docked, Charging
measure_battery       Battery percentage (0-100%)
fan_speed             Quiet, Normal, Strong
water_level           Low, Medium, High
measure_cleaning_area Cleaned area in m²


Feedback & Support
------------------

Found a bug or have a feature request? Open an issue on GitHub:
https://github.com/ndgmedia/homey-midea-vacuum/issues

// Copy this file to secrets.h (same folder) and fill in your values.
// secrets.h is listed in .gitignore, so your passwords never end up in git.
#pragma once
#include <stdint.h>

static const char *WIFI_SSID = "YOUR_WIFI_NAME";
static const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
static const char *MQTT_HOST = "192.168.1.10";
static const uint16_t MQTT_PORT = 1883;
static const char *MQTT_USER = "";      // leave empty if the broker allows anonymous access
static const char *MQTT_PASSWORD = "";
// Topic that publishes the inverter output power in watts as a plain number, e.g. "1240".
static const char *POWER_TOPIC = "home/inverter/output_power_w";

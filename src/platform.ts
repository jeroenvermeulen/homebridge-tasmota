import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
// import { tasmotaAccessory } from './platformAccessory';
import { tasmotaSwitchService } from './tasmotaSwitchService';
import { tasmotaLightService } from './tasmotaLightService';
import { tasmotaSensorService } from './tasmotaSensorService';
import { tasmotaBinarySensorService } from './tasmotaBinarySensorService';
import { Mqtt } from './lib/Mqtt';
import createDebug from 'debug';
import debugEnable from 'debug';

const debug = createDebug('Tasmota:platform');

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class tasmotaPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  public readonly services = {};

  // Auto removal of non responding devices

  private cleanup;
  private timeouts = {};
  private timeoutCounter = 1;
  private debug;
  public statusEvent = {};

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    this.cleanup = this.config['cleanup'] || 24; // Default removal of defunct devices after 24 hours
    this.debug = this.config['debug'] || false;

    if (this.debug) {

      let namespaces = debugEnable.disable();

      // this.log("DEBUG-1", namespaces);
      if (namespaces) {
        namespaces = namespaces + ',Tasmota*';
      } else {
        namespaces = 'Tasmota*';
      }
      // this.log("DEBUG-2", namespaces);
      debugEnable.enable(namespaces);
    }

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    accessory.context.timeout = this.autoCleanup(accessory);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {

    debug('discoverDevices');
    // EXAMPLE ONLY
    // A real plugin you would discover accessories from the local network, cloud services
    // or a user-defined array in the platform config.

    const mqttHost = new Mqtt(this.config);

    // debug('MqttHost', mqttHost);

    mqttHost.on('Discovered', (config) => {
      debug('Discovered ->', config.name, config);

      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const message = normalizeMessage(config);
      // debug('normalizeMessage ->', message);
      let identifier = message.dev.ids[0];
      let uniq_id = message.uniq_id;

      const uuid = this.api.hap.uuid.generate(identifier);

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        // the accessory already exists


        // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
        // existingAccessory.context.device = device;
        // this.api.updatePlatformAccessories([existingAccessory]);

        // create the accessory handler for the restored accessory
        // this is imported from `platformAccessory.ts`

        existingAccessory.context.mqttHost = mqttHost;
        existingAccessory.context.device[uniq_id] = message;

        if (this.services[uniq_id]) {
          this.log.warn('Restoring existing service from cache:', message.name);
          this.services[uniq_id].refresh();
        } else {
          this.log.info('Creating service:', message.name, message.tasmotaType);
          switch (message.tasmotaType) {
            case 'sensor':
              this.services[uniq_id] = new tasmotaSensorService(this, existingAccessory, uniq_id);
              break;
            case 'light':
              this.services[uniq_id] = new tasmotaLightService(this, existingAccessory, uniq_id);
              break;
            case 'switch':
              this.services[uniq_id] = new tasmotaSwitchService(this, existingAccessory, uniq_id);
              break;
            case 'binary_sensor':
              this.services[uniq_id] = new tasmotaBinarySensorService(this, existingAccessory, uniq_id);
              break;
            default:
              this.log.warn('Warning: Unhandled Tasmota device type', message.tasmotaType);
          }
        }

        this.api.updatePlatformAccessories([existingAccessory]);

      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory:', message.name);

        // create a new accessory
        const accessory = new this.api.platformAccessory(message.name, uuid);

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context.device = {};
        accessory.context.device[uniq_id] = message;
        accessory.context.mqttHost = mqttHost;

        // create the accessory handler for the newly create accessory
        // this is imported from `platformAccessory.ts`
        switch (message.tasmotaType) {
          case 'switch':
            this.services[uniq_id] = new tasmotaSwitchService(this, accessory, uniq_id);
            break;
          case 'light':
            this.services[uniq_id] = new tasmotaLightService(this, accessory, uniq_id);
            break;
          case 'sensor':
            this.services[uniq_id] = new tasmotaSensorService(this, accessory, uniq_id);
            break;
          case 'binary_sensor':
            this.services[uniq_id] = new tasmotaBinarySensorService(this, accessory, uniq_id);
            break;
          default:
            this.log.warn('Warning: Unhandled Tasmota device type', message.tasmotaType);
        }
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);

      }
    });
  }

  autoCleanup(accessory) {
    let timeoutID;

    // debug("autoCleanup", accessory.displayName, accessory.context.timeout, this.timeouts);

    if (accessory.context.timeout) {
      timeoutID = accessory.context.timeout;
      clearTimeout(this.timeouts[timeoutID]);
      delete this.timeouts[timeoutID];

    }

    timeoutID = this.timeoutCounter++;
    this.timeouts[timeoutID] = setTimeout(this.unregister.bind(this), this.cleanup * 60 * 60 * 1000, accessory, timeoutID);

    return (timeoutID);
  }

  unregister(accessory, timeoutID) {
    this.log.error('Removing %s', accessory.displayName);
    this.timeouts[timeoutID] = null;
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    // callback();
  }
}

/* The various Tasmota firmware's have a slightly different flavors of the message. */


function normalizeMessage(message) {

  const translation = {
    unique_id: 'uniq_id',
    device_class: 'dev_cla',
    payload_on: 'pl_on',
    payload_off: 'pl_off',
    device: 'dev',
    model: 'mdl',
    sw_version: 'sw',
    manufacturer: 'mf',
    identifiers: 'ids'
  };

  message = renameKeys(message, translation);

  if (message['~']) {
    message = replaceStringsInObject(message, '~', message['~']);
  }

  if (message.stat_t === 'sonoff/tele/STATE' || message.stat_t === 'tasmota/tele/STATE') {
    console.log('ERROR: %s has an incorrectly configure MQTT Topic, please make it unique.', message.name);
  }

  return (message);
}

function replaceStringsInObject(obj, findStr, replaceStr, cache = new Map()) {
    if (cache && cache.has(obj)) return cache.get(obj);

    const result = {};

    cache && cache.set(obj, result);

    for (let [key, value] of Object.entries(obj)) {
        let v: any = null;

        if(typeof value === 'string'){
            v = value.replace(RegExp(findStr, 'gi'), replaceStr);
        }
        else if (Array.isArray(value)) {
            // debug('isArray', value);
            v = value;
            // for (var i = 0; i < value.length; i++) {
            //    v[i] = replaceStringsInObject(value, findStr, replaceStr, cache);
            // }
        }
        else if(typeof value === 'object'){
            // debug('object', value);
            v = replaceStringsInObject(value, findStr, replaceStr, cache);
        }
        else {
            v = value;
        }
        result[key] = v;
    }

    return result;
}

function renameKeys(o, mapShortToLong) {
  var build, key, destKey, ix, value;

  if (Array.isArray(o)) {
    build = [];
  } else {
    build = {};
  }
  for (key in o) {
    // Get the destination key
    destKey = mapShortToLong[key] || key;

    // Get the value
    value = o[key];

    // If this is an object, recurse
    if (typeof value === "object") {
      // debug('recurse', value);
      value = renameKeys(value, mapShortToLong);
    }

    // Set it on the result using the destination key
    build[destKey] = value;
  }
  return build;
}

import assert from "assert";
import path from "path";
import { pathToFileURL } from "url";
import { satisfies } from "semver";
import {
  AccessoryIdentifier,
  AccessoryName,
  AccessoryPluginConstructor,
  API,
  PlatformIdentifier,
  PlatformName,
  DynamicPlatformPlugin,
  PlatformPluginConstructor,
  PluginIdentifier,
  PluginInitializer,
  PluginName,
} from "./api";
import { Logger } from "./logger";
import { PackageJSON, PluginManager } from "./pluginManager";
import getVersion from "./version";

const log = Logger.internal;

// Workaround for https://github.com/microsoft/TypeScript/issues/43329
const _importDynamic = new Function("modulePath", "return import(modulePath)");

/**
 * Represents a loaded Homebridge plugin.
 */
export class Plugin {

  private readonly pluginName: PluginName;
  private readonly scope?: string; // npm package scope
  private readonly pluginPath: string; // like "/usr/local/lib/node_modules/homebridge-lockitron"
  private readonly isESM: boolean;

  public disabled = false; // mark the plugin as disabled

  // ------------------ package.json content ------------------
  readonly version: string;
  private readonly main: string;
  private loadContext?: { // used to store data for a limited time until the load method is called, will be reset afterward
    engines?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  // ----------------------------------------------------------

  private pluginInitializer?: PluginInitializer; // default exported function from the plugin that initializes it

  private readonly registeredAccessories: Map<AccessoryName, AccessoryPluginConstructor> = new Map();
  private readonly registeredPlatforms: Map<PlatformName, PlatformPluginConstructor> = new Map();

  private readonly activeDynamicPlatforms: Map<PlatformName, DynamicPlatformPlugin[]> = new Map();

  constructor(name: PluginName, path: string, packageJSON: PackageJSON, scope?: string) {
    this.pluginName = name;
    this.scope = scope;
    this.pluginPath = path;

    this.version = packageJSON.version || "0.0.0";
    this.main = "";

    // figure out the main module
    // exports is available - https://nodejs.org/dist/latest-v14.x/docs/api/packages.html#packages_package_entry_points
    if (packageJSON.exports) {
      // main entrypoint - https://nodejs.org/dist/latest-v14.x/docs/api/packages.html#packages_main_entry_point_export
      if (typeof packageJSON.exports === "string") {
        this.main = packageJSON.exports;
      } else { // subpath export - https://nodejs.org/dist/latest-v14.x/docs/api/packages.html#packages_subpath_exports
        // conditional exports - https://nodejs.org/dist/latest-v14.x/docs/api/packages.html#packages_conditional_exports
        const exports = packageJSON.exports.import || packageJSON.exports.require || packageJSON.exports.node || packageJSON.exports.default || packageJSON.exports["."];

        // check if conditional export is nested
        if (typeof exports !== "string") {
          if(exports.import) {
            this.main = exports.import;
          } else {
            this.main = exports.require || exports.node || exports.default;
          }
        } else {
          this.main = exports;
        }
      }
    }

    // exports search was not successful, fallback to package.main, using index.js as fallback
    if (!this.main) {
      this.main = packageJSON.main || "./index.js";
    }

    // check if it is an ESM module
    this.isESM = this.main.endsWith(".mjs") || (this.main.endsWith(".js") && packageJSON.type === "module");

    // very temporary fix for first wave of plugins
    if (packageJSON.peerDependencies && (!packageJSON.engines || !packageJSON.engines.homebridge)) {
      packageJSON.engines = packageJSON.engines || {};
      packageJSON.engines.homebridge = packageJSON.peerDependencies.homebridge;
    }

    this.loadContext = {
      engines: packageJSON.engines,
      dependencies: packageJSON.dependencies,
    };
  }

  public getPluginIdentifier(): PluginIdentifier { // return full plugin name with scope prefix
    return (this.scope? this.scope + "/": "") + this.pluginName;
  }

  public getPluginPath(): string {
    return this.pluginPath;
  }

  public registerAccessory(name: AccessoryName, constructor: AccessoryPluginConstructor): void {
    if (this.registeredAccessories.has(name)) {
      throw new Error(`Plugin '${this.getPluginIdentifier()}' tried to register an accessory '${name}' which has already been registered!`);
    }

    if (!this.disabled) {
      log.info("Registering accessory '%s'", this.getPluginIdentifier() + "." + name);
    }

    this.registeredAccessories.set(name, constructor);
  }

  public registerPlatform(name: PlatformName, constructor: PlatformPluginConstructor): void {
    if (this.registeredPlatforms.has(name)) {
      throw new Error(`Plugin '${this.getPluginIdentifier()}' tried to register a platform '${name}' which has already been registered!`);
    }

    if (!this.disabled) {
      log.info("Registering platform '%s'", this.getPluginIdentifier() + "." + name);
    }

    this.registeredPlatforms.set(name, constructor);
  }

  public getAccessoryConstructor(accessoryIdentifier: AccessoryIdentifier | AccessoryName): AccessoryPluginConstructor {
    const name: AccessoryName = PluginManager.getAccessoryName(accessoryIdentifier);

    const constructor = this.registeredAccessories.get(name);
    if (!constructor) {
      throw new Error(`The requested accessory '${name}' was not registered by the plugin '${this.getPluginIdentifier()}'.`);
    }

    return constructor;
  }

  public getPlatformConstructor(platformIdentifier: PlatformIdentifier | PlatformName): PlatformPluginConstructor {
    const name: PlatformName = PluginManager.getPlatformName(platformIdentifier);

    const constructor = this.registeredPlatforms.get(name);
    if (!constructor) {
      throw new Error(`The requested platform '${name}' was not registered by the plugin '${this.getPluginIdentifier()}'.`);
    }

    if (this.activeDynamicPlatforms.has(name)) { // if it's a dynamic platform check that it is not enabled multiple times
      log.error("The dynamic platform " + name + " from the plugin " + this.getPluginIdentifier() + " seems to be configured " +
        "multiple times in your config.json. This behaviour was deprecated in homebridge v1.0.0 and will be removed in v2.0.0!");
    }

    return constructor;
  }

  public assignDynamicPlatform(platformIdentifier: PlatformIdentifier | PlatformName, platformPlugin: DynamicPlatformPlugin): void {
    const name: PlatformName = PluginManager.getPlatformName(platformIdentifier);

    let platforms = this.activeDynamicPlatforms.get(name);
    if (!platforms) {
      platforms = [];
      this.activeDynamicPlatforms.set(name, platforms);
    }

    // the last platform published should be at the first position for easy access
    // we just try to mimic pre 1.0.0 behavior
    platforms.unshift(platformPlugin);
  }

  public getActiveDynamicPlatform(platformName: PlatformName): DynamicPlatformPlugin | undefined {
    const platforms = this.activeDynamicPlatforms.get(platformName);
    // we always use the last registered
    return platforms && platforms[0];
  }

  public async load(): Promise<void> {
    const context = this.loadContext!;
    assert(context, "Reached illegal state. Plugin state is undefined!");
    this.loadContext = undefined; // free up memory

    // pluck out the HomeBridge version requirement
    if (!context.engines || !context.engines.homebridge) {
      throw new Error(`Plugin ${this.pluginPath} does not contain the 'homebridge' package in 'engines'.`);
    }

    const versionRequired = context.engines.homebridge;
    const nodeVersionRequired = context.engines.node;

    // make sure the version is satisfied by the currently running version of HomeBridge
    if (!satisfies(getVersion(), versionRequired, { includePrerelease: true })) {
      // TODO - change this back to an error
      log.error(`The plugin "${this.pluginName}" requires a Homebridge version of ${versionRequired} which does \
not satisfy the current Homebridge version of ${getVersion()}. You may need to update this plugin (or Homebridge) to a newer version. \
You may face unexpected issues or stability problems running this plugin.`);
    }

    // make sure the version is satisfied by the currently running version of Node
    if (nodeVersionRequired && !satisfies(process.version, nodeVersionRequired)) {
      log.warn(`The plugin "${this.pluginName}" requires Node.js version of ${nodeVersionRequired} which does \
not satisfy the current Node.js version of ${process.version}. You may need to upgrade your installation of Node.js - see https://homebridge.io/w/JTKEF`);
    }

    const dependencies = context.dependencies || {};
    if (dependencies.homebridge || dependencies["hap-nodejs"]) {
      log.error(`The plugin "${this.pluginName}" defines 'homebridge' and/or 'hap-nodejs' in their 'dependencies' section, \
meaning they carry an additional copy of homebridge and hap-nodejs. This not only wastes disk space, but also can cause \
major incompatibility issues and thus is considered bad practice. Please inform the developer to update their plugin!`);
    }

    const mainPath = path.join(this.pluginPath, this.main);

    // try to require() it and grab the exported initialization hook
    // eslint-disable-next-line @typescript-eslint/no-var-requires

    // pathToFileURL(specifier).href to turn a path into a "file url"
    // see https://github.com/nodejs/node/issues/31710

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pluginModules = this.isESM ? await _importDynamic(pathToFileURL(mainPath).href) : require(mainPath);

    if (typeof pluginModules === "function") {
      this.pluginInitializer = pluginModules;
    } else if (pluginModules && typeof pluginModules.default === "function") {
      this.pluginInitializer = pluginModules.default;
    } else {
      throw new Error(`Plugin ${this.pluginPath} does not export a initializer function from main.`);
    }
  }

  public initialize(api: API): void | Promise<void> {
    if (!this.pluginInitializer) {
      throw new Error("Tried to initialize a plugin which hasn't been loaded yet!");
    }

    return this.pluginInitializer(api);
  }


}

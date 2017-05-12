import { readFileSync } from 'fs';
import { basename, dirname, extname, join, relative } from 'path';

import * as MagicStringLib from 'magic-string';

import { AotCompiler } from './aot/aot-compiler';
import { Logger } from './logger/logger';
import { fillConfigDefaults, getUserConfigFile, replacePathVars } from './util/config';
import * as Constants from './util/constants';
import { BuildError } from './util/errors';
import { changeExtension,
        getBooleanPropertyValue,
        getStringPropertyValue,
        printDependencyMap,
        readAndCacheFile,
        webpackStatsToDependencyMap
} from './util/helpers';
import { AotMetadata, BuildContext, MagicString, TaskInfo, TreeShakeCalcResults } from './util/interfaces';
import { runWebpackFullBuild, WebpackConfig } from './webpack';
import { addPureAnnotation, purgeStaticCtorFields, purgeStaticFieldDecorators, purgeTranspiledDecorators } from './optimization/decorators';
import { purgeUnusedProvider, purgeUnusedEntryComponent } from './optimization/metadata';
import { calculateUnusedComponents,
        checkIfProviderIsUsedInSrc,
        getIonicModuleFilePath,
        getPublicApiSymbols,
        purgeComponentNgFactoryImportAndUsage,
        purgeExportedSymbolsFromFesm,
        purgeModuleFromFesm,
        purgeProviderControllerImportAndUsage,
        purgeProviderClassNameFromIonicModuleForRoot,
        purgeUnusedImportsAndExportsFromModuleFile,
        purgeUnusedExportsFromIndexFile,

} from './optimization/treeshake';

export function optimization(context: BuildContext, configFile: string) {
  const logger = new Logger(`optimization`);
  return optimizationWorker(context, configFile).then(() => {
      logger.finish();
    })
    .catch((err: Error) => {
      const error = new BuildError(err.message);
      error.isFatal = true;
      throw logger.fail(error);
    });
}

function optimizationWorker(context: BuildContext, configFile: string): Promise<any> {
  const webpackConfig = getConfig(context, configFile);
  let dependencyMap: Map<string, Set<string>> = null;
  let response: TreeShakeCalcResults = null;
  let fesmMagicString: MagicString = null;
  if (optimizationEnabled()) {
    return runWebpackFullBuild(webpackConfig).then((stats: any) => {
      dependencyMap = webpackStatsToDependencyMap(context, stats);
      if (getBooleanPropertyValue(Constants.ENV_PRINT_ORIGINAL_DEPENDENCY_TREE)) {
        Logger.debug('Original Dependency Map Start');
        printDependencyMap(dependencyMap);
        Logger.debug('Original Dependency Map End');
      }

      purgeGeneratedFiles(context, webpackConfig.output.filename);
    }).then(() => {
      return readAndCacheFile(getStringPropertyValue(Constants.ENV_VAR_IONIC_ANGULAR_FESM_ENTRY_POINT));
    }).then(() => {
      return doOptimizations(context, dependencyMap);
    }).then((treeShakeResults: TreeShakeCalcResults) => {
      response = treeShakeResults;
      // purge all ionic-angular files from the cache
      purgeFilesFromCache(context);
      // read the fesm
      return context.fileCache.get(getStringPropertyValue(Constants.ENV_VAR_IONIC_ANGULAR_FESM_ENTRY_POINT)).content;
    }).then((fesmContent: string) => {

      fesmMagicString = new MagicStringLib(fesmContent);
      if (response.purgedModules) {
        response.purgedModules.forEach((set: Set<string>, modulePath: string) => {
          fesmMagicString = purgeModuleFromFesm(fesmContent, modulePath, fesmMagicString);
        });
      }
      const updatedFesm = fesmMagicString.toString();
      context.fileCache.set(getStringPropertyValue(Constants.ENV_VAR_IONIC_ANGULAR_FESM_ENTRY_POINT), { path: getStringPropertyValue(Constants.ENV_VAR_IONIC_ANGULAR_FESM_ENTRY_POINT), content: updatedFesm});
    }).then(() => {
      // load the fesm's metadata.json file
      return readAndCacheFile(getStringPropertyValue(Constants.ENV_VAR_IONIC_ANGULAR_FESM_METADATA));
    }).then((metadataStringContent: string) => {
      let metadataObject = JSON.parse(metadataStringContent) as AotMetadata;
      metadataObject = purgeUnusedProviders(context, response.purgedModules, metadataObject);
      metadataObject = purgeUnusedEntryComponents(context, response.purgedModules, metadataObject);
      const metadataString = JSON.stringify(metadataObject);
      if (metadataString === metadataStringContent) {
        console.log('metadata not changed');
      } else {
        console.log('woot, metadata has been changed');
      }
      context.fileCache.set(getStringPropertyValue(Constants.ENV_VAR_IONIC_ANGULAR_FESM_METADATA), { path: getStringPropertyValue(Constants.ENV_VAR_IONIC_ANGULAR_FESM_METADATA), content: metadataString});
    }).then(() => {
      return purgeExportsFromFesm(context, response.purgedModules, fesmMagicString);
    }).then(() => {
      console.log('Running AOT again');
      const compiler = new AotCompiler(context, { entryPoint: process.env[Constants.ENV_APP_ENTRY_POINT],
                                            rootDir: context.rootDir,
                                            tsConfigPath: process.env[Constants.ENV_TS_CONFIG],
                                            appNgModuleClass: process.env[Constants.ENV_APP_NG_MODULE_CLASS],
                                            appNgModulePath: process.env[Constants.ENV_APP_NG_MODULE_PATH],
                                            forOptimization: false
                                          });
      return compiler.compile();
    });
  } else {
    return Promise.resolve();
  }
}

export function purgeGeneratedFiles(context: BuildContext, fileNameSuffix: string) {
  const buildFiles = context.fileCache.getAll().filter(file => file.path.indexOf(context.buildDir) >= 0 && file.path.indexOf(fileNameSuffix) >= 0);
  buildFiles.forEach(buildFile => context.fileCache.remove(buildFile.path));
}

export function doOptimizations(context: BuildContext, dependencyMap: Map<string, Set<string>>): TreeShakeCalcResults {
  // remove decorators
  let modifiedMap = new Map(dependencyMap);
  if (getBooleanPropertyValue(Constants.ENV_PURGE_DECORATORS)) {
    removeDecorators(context);
  }

  let purgedModules: Map<string, Set<string>> = null;
  // remove unused component imports
  if (getBooleanPropertyValue(Constants.ENV_MANUAL_TREESHAKING)) {
    // TODO remove this in a couple versions
    // only run manual tree shaking if the module file is found
    // since there is a breaking change here
    const ionicModulePath = getIonicModuleFilePath();
    if (context.fileCache.get(ionicModulePath)) {
      // due to how the angular compiler works in angular 4, we need to check if
      modifiedMap = checkIfProviderIsUsedInSrc(context, modifiedMap);
      const results = calculateUnusedComponents(modifiedMap);
      console.log('results.purged: ', results.purgedModules.size);
      console.log('results.notPurged: ', results.updatedDependencyMap.size);
      purgedModules = results.purgedModules;
      updateIonicComponentsUsed(context, results.updatedDependencyMap);
    }
  }

  if (getBooleanPropertyValue(Constants.ENV_PRINT_MODIFIED_DEPENDENCY_TREE)) {
    Logger.debug('Modified Dependency Map Start');
    printDependencyMap(modifiedMap);
    Logger.debug('Modified Dependency Map End');
  }


  return {
    purgedModules: purgedModules,
    updatedDependencyMap: modifiedMap
  };
}

export function updateIonicComponentsUsed(context: BuildContext, dependencyMap: Map<string, Set<string>>) {
  const componentsUsed = new Set<string>();
  const optimizationComponentsDir = getStringPropertyValue(Constants.ENV_VAR_IONIC_ANGULAR_OPTIMIZATION_COMPONENTS_DIR);
  const regularComponentsDir = getStringPropertyValue(Constants.ENV_VAR_IONIC_ANGULAR_COMPONENTS_DIR);
  dependencyMap.forEach((set: Set<string>, modulePath: string) => {
    if (modulePath.startsWith(optimizationComponentsDir)) {
      const relativePath = relative(optimizationComponentsDir, modulePath);
      const componentDir = join(regularComponentsDir, dirname(relativePath));
      // we want the existing list of components to include any of the content in the new list
      // the reason for this is some directories do not have sass files, and no sass errors out
      if (componentDir !== regularComponentsDir && context.includedIonicComponentPaths.has(componentDir)) {
        componentsUsed.add(componentDir);
      }
    }
  });
  context.includedIonicComponentPaths = componentsUsed;
}

function purgeFilesFromCache(context: BuildContext) {
  const filesToRemove = context.fileCache.getAll();
  filesToRemove.forEach(file => {
    if (file.path !== getStringPropertyValue(Constants.ENV_VAR_IONIC_ANGULAR_FESM_ENTRY_POINT)) {
      context.fileCache.remove(file.path);
    }
  });
}

function optimizationEnabled() {
  const purgeDecorators = getBooleanPropertyValue(Constants.ENV_PURGE_DECORATORS);
  const manualTreeshaking = getBooleanPropertyValue(Constants.ENV_MANUAL_TREESHAKING);
  return purgeDecorators || manualTreeshaking;
}

function removeDecorators(context: BuildContext) {
  const jsFiles = context.fileCache.getAll().filter(file => extname(file.path) === '.js');
  jsFiles.forEach(jsFile => {
    let magicString = new MagicStringLib(jsFile.content);
    magicString = purgeStaticFieldDecorators(jsFile.path, jsFile.content, magicString);
    magicString = purgeStaticCtorFields(jsFile.path, jsFile.content, magicString);
    magicString = purgeTranspiledDecorators(jsFile.path, jsFile.content, magicString);
    magicString = addPureAnnotation(jsFile.path, jsFile.content, magicString);
    jsFile.content = magicString.toString();
    const sourceMap = magicString.generateMap({
      source: basename(jsFile.path),
      file: basename(jsFile.path),
      includeContent: true
    });
    const sourceMapPath = jsFile.path + '.map';
    context.fileCache.set(sourceMapPath, { path: sourceMapPath, content: sourceMap.toString()});
  });
}

function purgeUnusedProviders(context: BuildContext, purgeDependencyMap: Map<string, Set<string>>, metadataObject: AotMetadata) {
  metadataObject = attemptToPurgeUnusedProvider(context, purgeDependencyMap, metadataObject, getStringPropertyValue(Constants.ENV_ACTION_SHEET_CONTROLLER_PATH), getStringPropertyValue(Constants.ENV_ACTION_SHEET_CONTROLLER_CLASSNAME));
  metadataObject = attemptToPurgeUnusedProvider(context, purgeDependencyMap, metadataObject, getStringPropertyValue(Constants.ENV_ALERT_CONTROLLER_PATH), getStringPropertyValue(Constants.ENV_ALERT_CONTROLLER_CLASSNAME));
  metadataObject = attemptToPurgeUnusedProvider(context, purgeDependencyMap, metadataObject, getStringPropertyValue(Constants.ENV_LOADING_CONTROLLER_PATH), getStringPropertyValue(Constants.ENV_LOADING_CONTROLLER_CLASSNAME));
  metadataObject = attemptToPurgeUnusedProvider(context, purgeDependencyMap, metadataObject, getStringPropertyValue(Constants.ENV_MODAL_CONTROLLER_PATH), getStringPropertyValue(Constants.ENV_MODAL_CONTROLLER_CLASSNAME));
  metadataObject = attemptToPurgeUnusedProvider(context, purgeDependencyMap, metadataObject, getStringPropertyValue(Constants.ENV_PICKER_CONTROLLER_PATH), getStringPropertyValue(Constants.ENV_PICKER_CONTROLLER_CLASSNAME));
  metadataObject = attemptToPurgeUnusedProvider(context, purgeDependencyMap, metadataObject, getStringPropertyValue(Constants.ENV_POPOVER_CONTROLLER_PATH), getStringPropertyValue(Constants.ENV_POPOVER_CONTROLLER_CLASSNAME));
  metadataObject = attemptToPurgeUnusedProvider(context, purgeDependencyMap, metadataObject, getStringPropertyValue(Constants.ENV_TOAST_CONTROLLER_PATH), getStringPropertyValue(Constants.ENV_TOAST_CONTROLLER_CLASSNAME));
  return metadataObject;
}

function purgeUnusedEntryComponents(context: BuildContext, purgeDependencyMap: Map<string, Set<string>>, metadataObject: AotMetadata) {
  metadataObject = attemptToPurgeUnusedEntryComponents(context, purgeDependencyMap, metadataObject, getStringPropertyValue(Constants.ENV_ACTION_SHEET_COMPONENT_PATH), getStringPropertyValue(Constants.ENV_ACTION_SHEET_COMPONENT_FACTORY_PATH), getStringPropertyValue(Constants.ENV_ACTION_SHEET_COMPONENT_CLASSNAME));
  metadataObject = attemptToPurgeUnusedEntryComponents(context, purgeDependencyMap, metadataObject, getStringPropertyValue(Constants.ENV_ALERT_COMPONENT_PATH), getStringPropertyValue(Constants.ENV_ALERT_COMPONENT_FACTORY_PATH), getStringPropertyValue(Constants.ENV_ALERT_COMPONENT_CLASSNAME));
  metadataObject = attemptToPurgeUnusedEntryComponents(context, purgeDependencyMap, metadataObject, getStringPropertyValue(Constants.ENV_LOADING_COMPONENT_PATH), getStringPropertyValue(Constants.ENV_LOADING_COMPONENT_FACTORY_PATH), getStringPropertyValue(Constants.ENV_LOADING_COMPONENT_CLASSNAME));
  metadataObject = attemptToPurgeUnusedEntryComponents(context, purgeDependencyMap, metadataObject, getStringPropertyValue(Constants.ENV_MODAL_COMPONENT_PATH), getStringPropertyValue(Constants.ENV_MODAL_COMPONENT_FACTORY_PATH), getStringPropertyValue(Constants.ENV_MODAL_COMPONENT_CLASSNAME));
  metadataObject = attemptToPurgeUnusedEntryComponents(context, purgeDependencyMap, metadataObject, getStringPropertyValue(Constants.ENV_PICKER_COMPONENT_PATH), getStringPropertyValue(Constants.ENV_PICKER_COMPONENT_FACTORY_PATH), getStringPropertyValue(Constants.ENV_PICKER_COMPONENT_CLASSNAME));
  metadataObject = attemptToPurgeUnusedEntryComponents(context, purgeDependencyMap, metadataObject, getStringPropertyValue(Constants.ENV_POPOVER_COMPONENT_PATH), getStringPropertyValue(Constants.ENV_POPOVER_COMPONENT_FACTORY_PATH), getStringPropertyValue(Constants.ENV_POPOVER_COMPONENT_CLASSNAME));
  metadataObject = attemptToPurgeUnusedEntryComponents(context, purgeDependencyMap, metadataObject, getStringPropertyValue(Constants.ENV_TOAST_COMPONENT_PATH), getStringPropertyValue(Constants.ENV_TOAST_COMPONENT_FACTORY_PATH), getStringPropertyValue(Constants.ENV_TOAST_COMPONENT_CLASSNAME));
  metadataObject = attemptToPurgeUnusedEntryComponents(context, purgeDependencyMap, metadataObject, getStringPropertyValue(Constants.ENV_SELECT_POPOVER_COMPONENT_PATH), getStringPropertyValue(Constants.ENV_SELECT_POPOVER_COMPONENT_FACTORY_PATH), getStringPropertyValue(Constants.ENV_SELECT_POPOVER_CLASSNAME));
  return metadataObject;
}

// TODO, this is ugly and half functional but yolo
function attemptToPurgeUnusedProvider(context: BuildContext, dependencyMap: Map<string, Set<string>>, metadataObject: AotMetadata, providerPath: string, providerClassName: string) {
  if (dependencyMap.has(providerPath)) {
    const fesmPath = getStringPropertyValue(Constants.ENV_VAR_IONIC_ANGULAR_FESM_ENTRY_POINT);
    const fesmFile = context.fileCache.get(fesmPath);
    const updatedContent = purgeProviderClassNameFromIonicModuleForRoot(fesmFile.content, providerClassName);
    context.fileCache.set(fesmPath, { path: fesmPath, content: updatedContent});
    metadataObject = purgeUnusedProvider(metadataObject, providerClassName);
  }
  return metadataObject;
}

// TODO, this is ugly and half functional but yolo
function attemptToPurgeUnusedEntryComponents(context: BuildContext, dependencyMap: Map<string, Set<string>>, metadataObject: AotMetadata, entryComponentPath: string, entryComponentFactoryPath: string, className: string) {
  if (dependencyMap.has(entryComponentPath)) {
    const ngModuleFactoryFiles = context.fileCache.getAll().filter(file => file.path.endsWith(changeExtension(getStringPropertyValue(Constants.ENV_NG_MODULE_FILE_NAME_SUFFIX), '.ngfactory.js')));
    ngModuleFactoryFiles.forEach(ngModuleFactoryFile => {
      const updatedContent = purgeComponentNgFactoryImportAndUsage(ngModuleFactoryFile.path, ngModuleFactoryFile.content, entryComponentFactoryPath);
      context.fileCache.set(ngModuleFactoryFile.path, { path: ngModuleFactoryFile.path, content: updatedContent});
    });
    metadataObject = purgeUnusedEntryComponent(metadataObject, className);
  }
  return metadataObject;
}

function purgeExportsFromFesm(context: BuildContext, purgedModules: Map<string, Set<string>>, magicString: MagicString) {
  const optimizationEntryPoint = getStringPropertyValue(Constants.ENV_VAR_IONIC_ANGULAR_OPTIMIZATION_ENTRY_POINT);
  return readAndCacheFile(optimizationEntryPoint).then((fileContent: string) => {
    const symbolMap = getPublicApiSymbols(optimizationEntryPoint, fileContent);

    const aggregateSymbols = new Set<string>();
    purgedModules.forEach((set: Set<string>, modulePath: string) => {
      // convert path of purged module to find symbols
      const relativePath = relative(dirname(optimizationEntryPoint), modulePath);
      const extensionless = changeExtension(relativePath, '');
      const symbols = symbolMap.get(extensionless);
      if (symbols) {
        symbols.forEach(symbol => aggregateSymbols.add(symbol));
      }
    });

    // purge the symbols from the export list of the fesm
    const fesmPath = getStringPropertyValue(Constants.ENV_VAR_IONIC_ANGULAR_FESM_ENTRY_POINT);
    const fesmFile = context.fileCache.get(fesmPath);
    if (!fesmFile) {
      throw new Error('Fesm not in cache - unable to purge exports');
    }
    magicString = purgeExportedSymbolsFromFesm(fesmPath, fesmFile.content, aggregateSymbols, magicString);
    const updatedFesmContent = magicString.toString();
    console.log(updatedFesmContent);
    context.fileCache.set(fesmPath, { path: fesmPath, content: updatedFesmContent});
  });

}

export function getConfig(context: BuildContext, configFile: string): WebpackConfig {
  configFile = getUserConfigFile(context, taskInfo, configFile);

  let webpackConfig: WebpackConfig = fillConfigDefaults(configFile, taskInfo.defaultConfigFile);
  webpackConfig.entry = replacePathVars(context, webpackConfig.entry);
  webpackConfig.output.path = replacePathVars(context, webpackConfig.output.path);

  return webpackConfig;
}

const taskInfo: TaskInfo = {
  fullArg: '--optimization',
  shortArg: '-dt',
  envVar: 'IONIC_DEPENDENCY_TREE',
  packageConfig: 'ionic_dependency_tree',
  defaultConfigFile: 'optimization.config'
};

interface OptimizationResults {
  purgedModules: string[];
  includedModules: string[];
}

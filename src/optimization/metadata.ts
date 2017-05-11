import { AotMetadata, AotMetadataDecoratorNode, NgModuleMetadataNode,  } from '../util/interfaces';

export function purgeUnusedProvider(metadataObject: AotMetadata, classNameToRemove: string) {
  metadataObject = removeClassFromOriginNode(metadataObject, classNameToRemove);
  metadataObject = removeClassFromMetadataRoot(metadataObject, classNameToRemove);
  metadataObject = removeProviderFromIonicModule(metadataObject, classNameToRemove);
  return metadataObject;
}

export function purgeUnusedEntryComponent(metadataObject: AotMetadata, classNameToRemove: string) {
  metadataObject = removeIonicModuleDeclarations(metadataObject, classNameToRemove);
  metadataObject = removeIonicModuleExport(metadataObject, classNameToRemove);
  metadataObject = removeIonicModuleEntryComponents(metadataObject, classNameToRemove);
  metadataObject = removeClassFromOriginNode(metadataObject, classNameToRemove);
  metadataObject = removeClassFromMetadataRoot(metadataObject, classNameToRemove);
  return metadataObject;
}

function removeIonicModuleNgModuleMetadataEntry(metadataObject: AotMetadata, classNameToRemove: string, argumentField: string) {
  const argumentsList = getIonicModuleArgumentsArray(metadataObject);
  if (argumentsList) {
    argumentsList.forEach((argument: any) => {
      const ngModuleMetadataEntries = argument[argumentField] as NgModuleMetadataNode[];
      if (ngModuleMetadataEntries) {
        const newDeclarations = ngModuleMetadataEntries.filter(ngModuleMetadataType => ngModuleMetadataType.name !== classNameToRemove);
        argument[argumentField] = newDeclarations;
      }
    });
  }
  return metadataObject;
}

export function removeIonicModuleDeclarations(metadataObject: AotMetadata, classNameToRemove: string) {
  return removeIonicModuleNgModuleMetadataEntry(metadataObject, classNameToRemove, DECLARATIONS_KEY);
}

export function removeIonicModuleExport(metadataObject: AotMetadata, classNameToRemove: string) {
  return removeIonicModuleNgModuleMetadataEntry(metadataObject, classNameToRemove, EXPORTS_KEY);
}

export function removeIonicModuleEntryComponents(metadataObject: AotMetadata, classNameToRemove: string) {
  return removeIonicModuleNgModuleMetadataEntry(metadataObject, classNameToRemove, ENTRY_COMPONENTS_KEY);
}

function getIonicModuleArgumentsArray(metadataObject: AotMetadata): any {
  const ionicModuleObject = metadataObject.metadata[IONIC_MODULE_KEY];
  if (ionicModuleObject && ionicModuleObject.decorators) {
    ionicModuleObject.decorators.forEach((node: AotMetadataDecoratorNode) => {
      if (node.arguments) {
        return node.arguments;
      }
    });
  }
  return null;
}

export function removeClassFromOriginNode(metadataObject: AotMetadata, classNameToRemove: string) {
  const originsNode = metadataObject.origins;
  if (originsNode) {
    const newOrigins = Object.keys(originsNode)
      .filter(key => key !== classNameToRemove)
      .reduce((all: any, key) => {
        all[key] = originsNode[key];
        return all;
      }, {});
    metadataObject.origins = newOrigins;
  }
  return metadataObject;
}

export function removeClassFromMetadataRoot(metadataObject: AotMetadata, classNameToRemove: string) {
  const metadataNode = metadataObject.metadata;
  if (metadataNode) {
    const newMetadata = Object.keys(metadataNode)
      .filter(key => key !== classNameToRemove)
      .reduce((all: any, key) => {
        all[key] = metadataNode[key];
        return all;
      }, {});
    metadataObject.metadata = newMetadata;
  }
  return metadataObject;
}

export function removeProviderFromIonicModule(metadataObject: AotMetadata, classNameToRemove: string) {
  const ionicModuleObject = metadataObject.metadata[IONIC_MODULE_KEY];
  if (ionicModuleObject
      && ionicModuleObject.statics
      && ionicModuleObject.statics.forRoot
      && ionicModuleObject.statics.forRoot.value
      && ionicModuleObject.statics.forRoot.value.providers
      && ionicModuleObject.statics.forRoot.value.providers.length) {

    const newProviders = ionicModuleObject.statics.forRoot.value.providers.filter((providerObject: any) => !providerObject.name || providerObject.name !== classNameToRemove);
    ionicModuleObject.statics.forRoot.value.providers = newProviders;
  }
  return metadataObject;
}

const IONIC_MODULE_KEY = 'IonicModule';
const DECLARATIONS_KEY = 'declarations';
const EXPORTS_KEY = 'exports';
const ENTRY_COMPONENTS_KEY = 'entryComponents';

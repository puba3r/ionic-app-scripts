import * as metadata from './metadata';
import * as helpers from '../util/helpers';


describe('metadata', () => {
  describe('purgeUnusedProvider', () => {
    it('should remove the class name provided', async () => {

      const knownFileContent = await getKnownFileContent();
      const metadataObject = JSON.parse(knownFileContent);
      const classToRemove = 'ToastController';
      const updatedObject = metadata.purgeUnusedProvider(metadataObject, classToRemove);
      const updatedFileContent = JSON.stringify(updatedObject);
      expect(updatedFileContent.indexOf(classToRemove)).toEqual(-1);
    });
  });

  describe('purgeUnusedEntryComponent', () => {
    it('should remove the entry component provided', async () => {
      const knownFileContent = await getKnownFileContent();
      const metadataObject = JSON.parse(knownFileContent);
      const classToRemove = 'ToastCmp';
      const updatedObject = metadata.purgeUnusedEntryComponent(metadataObject, classToRemove);
      const updatedFileContent = JSON.stringify(updatedObject);
      expect(updatedFileContent.indexOf(classToRemove)).toEqual(-1);
    });
  });
});

function getKnownFileContent() {
  const fileToRead = helpers.changeExtension(__filename, '.json');
  return helpers.readFileAsync(fileToRead).then((fileContent: string) => {
    return fileContent.trim();
  });
}

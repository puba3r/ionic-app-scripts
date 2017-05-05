import { CancellationToken, CompilerHost, CompilerOptions, createCompilerHost, ScriptTarget, SourceFile } from 'typescript';

import * as Constants from '../util/constants';
import { getIonicAngularPackageJsonFilePath } from '../util/helpers';
import { VirtualFileSystem } from '../util/interfaces';
import { getTypescriptSourceFile } from '../util/typescript-utils';
import { Logger } from '../logger/logger';

export interface OnErrorFn {
  (message: string): void;
}

export class NgcCompilerHost implements CompilerHost {
  private sourceFileMap: Map<string, SourceFile>;
  private diskCompilerHost: CompilerHost;

  constructor(private options: CompilerOptions, private fileSystem: VirtualFileSystem, private setParentNodes = true, private useFesm: boolean = false) {
    this.diskCompilerHost = createCompilerHost(this.options, this.setParentNodes);
    this.sourceFileMap = new Map<string, SourceFile>();
  }

  fileExists(filePath: string): boolean {
    const fileContent = this.fileSystem.getFileContent(filePath);
    if (fileContent) {
      return true;
    }
    return this.diskCompilerHost.fileExists(filePath);
  }

  readFile(filePath: string): string {
    //console.log('filePath: ', filePath);
    let fileContent = this.fileSystem.getFileContent(filePath);
    if (!fileContent) {
      fileContent = this.diskCompilerHost.readFile(filePath);
      if (filePath.endsWith('package.json')) {
        //this.fileSystem.addVirtualFile(filePath, fileContent);
      }
    }

    // if we're using the fesm and the path matches,
    // read the file and convert the typings and module fields
    // to point to the fesm
    if (this.useFesm && filePath === getIonicAngularPackageJsonFilePath()) {
      console.log('fileContent: ', fileContent);
      const packageJson = JSON.parse(fileContent);
      packageJson.module = packageJson['es5-fesm'];
      packageJson.types = packageJson['es5-fesm-types'];
      fileContent = JSON.stringify(packageJson);
    }

    return fileContent;
  }

  directoryExists(directoryPath: string): boolean {
    const stats = this.fileSystem.getDirectoryStats(directoryPath);
    if (stats) {
      return true;
    }
    return this.diskCompilerHost.directoryExists(directoryPath);
  }

  getFiles(directoryPath: string): string[] {
    return this.fileSystem.getFileNamesInDirectory(directoryPath);
  }

  getDirectories(directoryPath: string): string[] {
    const subdirs = this.fileSystem.getSubDirs(directoryPath);

    let delegated: string[];
    try {
      delegated = this.diskCompilerHost.getDirectories(directoryPath);
    } catch (e) {
      delegated = [];
    }
    return delegated.concat(subdirs);
  }

  getSourceFile(filePath: string, languageVersion: ScriptTarget, onError?: OnErrorFn) {
    const existingSourceFile = this.sourceFileMap.get(filePath);
    if (existingSourceFile) {
      return existingSourceFile;
    }
    // we haven't created a source file for this yet, so try to use what's in memory
    const fileContentFromMemory = this.fileSystem.getFileContent(filePath);
    if (fileContentFromMemory) {
      const typescriptSourceFile = getTypescriptSourceFile(filePath, fileContentFromMemory, languageVersion, this.setParentNodes);
      this.sourceFileMap.set(filePath, typescriptSourceFile);
      return typescriptSourceFile;
    }
    // dang, it's not in memory, load it from disk and cache it
    const diskSourceFile = this.diskCompilerHost.getSourceFile(filePath, languageVersion, onError);
    this.sourceFileMap.set(filePath, diskSourceFile);
    return diskSourceFile;
  }

  getCancellationToken(): CancellationToken {
    return this.diskCompilerHost.getCancellationToken();
  }

  getDefaultLibFileName(options: CompilerOptions) {
    return this.diskCompilerHost.getDefaultLibFileName(options);
  }

  writeFile(fileName: string, data: string, writeByteOrderMark: boolean, onError?: OnErrorFn) {
    Logger.debug(`[NgcCompilerHost] writeFile: adding ${fileName} to virtual file system`);
    this.fileSystem.addVirtualFile(fileName, data);
  }

  getCurrentDirectory(): string {
    return this.diskCompilerHost.getCurrentDirectory();
  }

  getCanonicalFileName(fileName: string): string {
    return this.diskCompilerHost.getCanonicalFileName(fileName);
  }

  useCaseSensitiveFileNames(): boolean {
    return this.diskCompilerHost.useCaseSensitiveFileNames();
  }

  getNewLine(): string {
    return this.diskCompilerHost.getNewLine();
  }
}

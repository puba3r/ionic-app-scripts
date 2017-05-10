import { CompilerOptions } from 'typescript';
import { NgcCompilerHost } from './compiler-host';
import { getInstance as getFileSystemInstance } from '../util/hybrid-file-system-factory';

export function getInstance(options: CompilerOptions, forOptimization: boolean) {
  return new NgcCompilerHost(options, getFileSystemInstance(), true, forOptimization);
}

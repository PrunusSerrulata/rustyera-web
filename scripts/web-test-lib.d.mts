export interface IsolatedProject {
  root: string;
  project: string;
  close(): Promise<void>;
}

export function isolatedProject(
  source: string,
  options?: {
    cleanSaves?: boolean;
    compiledCache?: boolean;
    compiledCacheInput?: string;
    sourceIndexInput?: string;
  },
): Promise<IsolatedProject>;

export function projectRuntimeStorageRoot(project: string): Promise<string>;

export function publishCrossHostArtifacts(options: {
  source: string;
  isolated: string;
  cacheInput?: string;
  cacheOutput?: string;
  sourceIndexInput?: string;
  sourceIndexOutput?: string;
  projectOutput?: string;
  succeeded: boolean;
  cacheSaved: boolean;
}): Promise<void>;

export function installRemoteFileSystem(
  page: {
    exposeBinding(
      name: string,
      callback: (source: unknown, request: unknown) => unknown,
    ): Promise<void>;
    addInitScript(script: () => void): Promise<void>;
  },
  root: string,
): Promise<void>;

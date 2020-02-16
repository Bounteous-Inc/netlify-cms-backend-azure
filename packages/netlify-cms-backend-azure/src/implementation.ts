import { trimStart, trim } from 'lodash';
import semaphore, { Semaphore } from 'semaphore';
import AuthenticationPage from './AuthenticationPage';
import API, { API_NAME, AzureRepo } from './API';
import {
  Credentials,
  Implementation,
  ImplementationFile,
  DisplayURL,
  basename,
  Entry,
  AssetProxy,
  PersistOptions,
  getMediaDisplayURL,
  getMediaAsBlob,
  Config,
  getPreviewStatus,
  asyncLock,
  AsyncLock,
  runWithLock,
  User,
  unpublishedEntries,
  UnpublishedEntryMediaFile
} from 'netlify-cms-lib-util';
import { getBlobSHA } from 'netlify-cms-lib-util/src';

const MAX_CONCURRENT_DOWNLOADS = 10;

/**
 * Keywords for inferring a status that will provide a deploy preview URL.
 */
const PREVIEW_CONTEXT_KEYWORDS = ['deploy'];

/**
 * Check a given status context string to determine if it provides a link to a
 * deploy preview. Checks for an exact match against `previewContext` if given,
 * otherwise checks for inclusion of a value from `PREVIEW_CONTEXT_KEYWORDS`.

function isPreviewContext(context, previewContext) {
  if (previewContext) {
    return context === previewContext;
  }
  return PREVIEW_CONTEXT_KEYWORDS.some(keyword => context.includes(keyword));
}
 */

/**
 * Retrieve a deploy preview URL from an array of statuses. By default, a
 * matching status is inferred via `isPreviewContext`.
 *
 function getPreviewStatus(statuses, config) {
  const previewContext = config.getIn(['backend', 'preview_context']);
  return statuses.find(({ context }) => {
    return isPreviewContext(context, previewContext);
  });
}
**/

export default class Azure implements Implementation {

  lock: AsyncLock;
  api: API | null;
  options: {
    proxied: boolean;
    API: API | null;
    initialWorkflowStatus: string;
  };
  identityUrl: string;
  repo: AzureRepo;
  branch: string;
  apiRoot: string;
  token: string | null;
  squashMerges: boolean;
  mediaFolder: string;
  previewContext: string;

  _mediaDisplayURLSem?: Semaphore;

  constructor(config : Config, options = {}) {
    this.options = {
      proxied: false,
      API: null,
      initialWorkflowStatus: '',
      ...options,
    };

    if (!this.options.proxied) {

      if (config.backend.repo === null || config.backend.repo === undefined)
      {
        throw new Error('The Azure backend needs a "repo" in the backend configuration.');
      }
    }

    this.api = this.options.API || null;

    this.repo = new AzureRepo(config.backend.repo);
    this.branch = config.backend.branch || 'master';
    this.identityUrl = config.backend.identity_url || '';
    this.apiRoot = config.backend.api_root || 'https://dev.azure.com';
    this.token = '';
    this.squashMerges = config.backend.squash_merges || false;
    this.mediaFolder = trim(config.media_folder, '/');
    this.previewContext = config.backend.preview_context || '';
    this.lock = asyncLock();
  }

  authComponent() {
    return AuthenticationPage;
  }

  restoreUser(user: User) {
    return this.authenticate(user);
  }

  /**
   * Handle authentication by creating the Azure DevOps API object, which
   * will be used for future operations. Also load details of the current
   * user.
   * 
   * @param state Oauth credentials containing implicit flow auth token.
   */
  async authenticate(state: Credentials) {
    this.token = state.token as string;
    this.api = new API({
      apiRoot: this.apiRoot,
      repo: this.repo,
      branch: this.branch,
      path: '/',
      squashMerges: this.squashMerges,
      initialWorkflowStatus: this.options.initialWorkflowStatus,
    },
    this.token);

    // Get a JSON representation of the user object and capture the name and email
    // address for later use on commits.
    const user = await this.api.user();
    this.api!.commitAuthor =  { name: user.displayName, email: user.emailAddress };
    return { name: user.displayName, token: state.token as string, ...user };
  }
  
  /**
   * Log the user out by forgetting their access token.
   * TODO: *Actual* logout by redirecting to: 
   * https://login.microsoftonline.com/{tenantId}/oauth2/logout?client_id={clientId}&post_logout_redirect_uri={baseUrl}
   */
  logout() {
    this.token = null;
    return;
  }

  getToken() {
    return Promise.resolve(this.token);
  }

  entriesByFolder(collection: string, extension: string, depth: number) {
    console.log('entriesByFolder');
    return this.api!
      .listFiles(collection)
      .then(files => { // Azure - de-activate filter for debug
        // files.filter(file => file.name.endsWith('.' + extension)))
        console.log('IMPL files-liste: ' + JSON.stringify (files ) );
        return files;
      })
    .then(this.fetchFiles);
  }

  entriesByFiles(files: ImplementationFile[]) {
    const listFiles = files.map((collectionFile : any)=> ({
      path: collectionFile.get('file'),
      label: collectionFile.get('label'),
    }));
    return this.fetchFiles(listFiles);
  }

  fetchFiles = (files: any)=> {
    const sem = semaphore(MAX_CONCURRENT_DOWNLOADS);
    const promises : any[] = [];
    files.forEach((file: any) => {
      file.sha = file.objectId; // due to different element naming in Azure
      file.path = file.relativePath;
      promises.push(
        new Promise(resolve =>
          sem.take(() =>
            this.api!
              .readFile(file.path, file.objectId) // Azure
              .then(data => {
                resolve({ file, data });
                sem.leave();
              })
              .catch((err = true) => {
                sem.leave();
                console.error(`failed to load file from Azure: ${file.path}`);
                resolve({ error: err });
              }),
          ),
        ),
      );
    });
    return Promise.all(promises).then(loadedEntries =>
      loadedEntries.filter(loadedEntry => !loadedEntry.error),
    );
  };

  // Fetches a single entry.
  getEntry(path: string) {
    return this.api!.readFile(path).then(data => ({
      file: { path },
      data: data as string
    }));
  }

  getMedia() {
    return this.api!.listFiles(this.mediaFolder).then(files =>
      
      files.map(({ objectId, relativePath, size, url }) => {
        const sha = objectId;
        const name = relativePath;
        const path = `${this.mediaFolder}/${relativePath}`;
        const url2 = new URL(url);

        if (url2.pathname.match(/.svg$/)) {
          //url2.search += (url2.search.slice(1) === '' ? '?' : '&') + 'sanitize=true';
        }

        return { id: sha, name, size, displayURL: url2.href, path };
      }),
    );
  }

  getMediaDisplayURL(displayURL: DisplayURL) {
    this._mediaDisplayURLSem = this._mediaDisplayURLSem || semaphore(MAX_CONCURRENT_DOWNLOADS);
    return getMediaDisplayURL(
      displayURL,
      this.api!.readFile.bind(this.api!),
      this._mediaDisplayURLSem,
    );
  }

  async getMediaFile(path: string) {
    const name = basename(path);
    const blob = await getMediaAsBlob(path, null, this.api!.readFile.bind(this.api!));
    const fileObj = new File([blob], name);
    const url = URL.createObjectURL(fileObj);
    const id = await getBlobSHA(blob);

    return {
      id,
      displayURL: url,
      path,
      name,
      size: fileObj.size,
      file: fileObj,
      url,
    };
  }

  persistEntry(entry: Entry, mediaFiles: AssetProxy[], options: PersistOptions) {
    return this.api!.persistFiles(entry, mediaFiles, options);
  }

  async persistMedia(mediaFile: AssetProxy, options: PersistOptions) {
    const fileObj = mediaFile.fileObj as File;

    const [id] = await Promise.all([
      getBlobSHA(fileObj),
      this.api!.persistFiles(null, [mediaFile], options),
    ]);

    const { path } = mediaFile;
    const url = URL.createObjectURL(fileObj);

    return {
      displayURL: url,
      path: trimStart(path, '/'),
      name: fileObj!.name,
      size: fileObj!.size,
      file: fileObj,
      url,
      id,
    };
  }

  deleteFile(path: string, commitMessage: string) {
    return this.api!.deleteFile(path, commitMessage);
  }

  loadMediaFile(branch: string, file: UnpublishedEntryMediaFile) {
    const readFile = (
      path: string,
      id: string | null | undefined,
      { parseText }: { parseText: boolean },
    ) => this.api!.readFile(path, id, { branch, parseText });

    return getMediaAsBlob(file.path, null, readFile).then(blob => {
      const name = basename(file.path);
      const fileObj = new File([blob], name);
      return {
        id: file.path,
        displayURL: URL.createObjectURL(fileObj),
        path: file.path,
        name,
        size: fileObj.size,
        file: fileObj,
      };
    });
  }

  async loadEntryMediaFiles(branch: string, files: UnpublishedEntryMediaFile[]) {
    const mediaFiles = await Promise.all(files.map(file => this.loadMediaFile(branch, file)));

    return mediaFiles;
  }

  async unpublishedEntries() {
    const listEntriesKeys = () =>
      this.api!.listUnpublishedBranches().then(branches =>
        branches.map((branch: any) => this.api!.contentKeyFromBranch(branch)),
      );

    const readUnpublishedBranchFile = (contentKey: string) =>
      this.api!.readUnpublishedBranchFile(contentKey);

    return unpublishedEntries(listEntriesKeys, readUnpublishedBranchFile, API_NAME);
  }

  async unpublishedEntry(  collection: string,
    slug: string,
    {
      loadEntryMediaFiles = (branch: string, files: UnpublishedEntryMediaFile[]) =>
        this.loadEntryMediaFiles(branch, files),
    } = {},
  ) {
    const contentKey = this.api!.generateContentKey(collection, slug);
    const data = await this.api!.readUnpublishedBranchFile(contentKey);
    const mediaFiles = await loadEntryMediaFiles(
      data.metaData.branch,
      data.metaData.objects.entry.mediaFiles,
    );
    return {
      slug,
      file: { path: data.metaData.objects.entry.path, id: null },
      data: data.fileData as string,
      metaData: data.metaData,
      mediaFiles,
      isModification: data.isModification,
    };
  }

  updateUnpublishedEntryStatus(collection: string, slug: string, newStatus: string) {
    // updateUnpublishedEntryStatus is a transactional operation
    return runWithLock(
      this.lock,
      () => this.api!.updateUnpublishedEntryStatus(collection, slug, newStatus),
      'Failed to acquire update entry status lock',
    );
  }

  deleteUnpublishedEntry(collection: string, slug: string) {
    // deleteUnpublishedEntry is a transactional operation
    return runWithLock(
      this.lock,
      () => this.api!.deleteUnpublishedEntry(collection, slug),
      'Failed to acquire delete entry lock',
    );
  }
  publishUnpublishedEntry(collection: string, slug: string) {
    // publishUnpublishedEntry is a transactional operation
    return runWithLock(
      this.lock,
      () => this.api!.publishUnpublishedEntry(collection, slug),
      'Failed to acquire publish entry lock',
    );
  }

    /**
   * Uses Azure's Statuses API to retrieve statuses, infers which is for a
   * deploy preview via `getPreviewStatus`. Returns the url provided by the
   * status, as well as the status state, which should be one of 'success',
   * 'pending', and 'failure'.
   */
  async getDeployPreview(collection: string, slug: string) {
    try {
      const data = await this.api!.retrieveMetadata(slug);

      if (!data) {
        return null;
      }

      const statuses = await this.api!.getStatuses(data.pr.head);
      const deployStatus = getPreviewStatus(statuses, this.previewContext);

      if (deployStatus) {
        const { target_url: url, state } = deployStatus;
        return { url, status: state };
      } else {
        return null;
      }
    } catch (e) {
      return null;
    }
  }
}

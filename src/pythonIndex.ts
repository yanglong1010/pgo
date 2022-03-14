import { platform, tmpdir, homedir } from 'os';
import { dirname, join, relative } from 'path';
import {
  ensureDir,
  lstat,
  readlink,
  createReadStream,
  createWriteStream,
  writeFile,
  existsSync,
  readFile,
  remove,
  copySync, copy, removeSync
} from 'fs-extra';

import * as globby from 'globby';
import * as JSZip from 'jszip';
import * as FCClientInner from '@alicloud/fc2';
import * as YAML from 'js-yaml';
import * as uuid from 'uuid-1345';
import * as tar from 'tar';
import * as child_process from 'child_process'
import {error, info, NAS, OSS, OSS_UTIL_URL, QUICK_START} from "./common";
import * as path from "path";
import * as OSSClient from 'ali-oss';
import got from 'got';
import {promisify} from "util";
import * as stream from "stream";
import * as fs from "fs";
import {copyFileSync} from "fs";
import * as sprintflib from "sprintf-js";

const Crypto = require('crypto-js');
const ServerlessDevsEncryptKey = 'SecretKey123';

const TMP_PATH = '/tmp';
const SRCTL = 'srctl';
const SRPATH = `${TMP_PATH}/runtime.data.share`;
const ARCHIVE_NAME = `${SRCTL}.tar.gz`;
const TEMP_ARCHIVE_NAME = `tmp-func.zip`;
const ARCHIVE_PATH = `${TMP_PATH}/${ARCHIVE_NAME}`;
const TEMP_FUNCTION_HANDLER = 'AccelerationHelper::handleRequest';
const SrctlSourcePath = join('..', 'resources', 'srctl');
const SrctlTargetPath = join('code', 'srctl');
const nameBase = 'trace-dump';
const tmpName = `${nameBase}-tmp-${Date.now()}`;
const tmpDir = join(tmpdir(), tmpName);
const tmpZipFilePath = join(tmpdir(), `${tmpName}.zip`);
const OssUtil = "ossutil64";

export class PythonStartupAcceleration {
  region;
  fcEndpoint;
  runtime;
  initializer;
  access;
  pwd = process.cwd();
  defaultCredential;
  artifactPath;
  targetPath;
  role;
  logConfig;
  sharedDirName;
  tmpSrpath;
  srpath;
  downloader;
  uploader;
  ossEndpoint;
  ossUtilUrl;
  ossBucket;
  ossKey;
  vpcConfig;
  nasConfig;
  timeout;
  initTimeout;
  maxMemory;
  tmpBucketName;
  enable;
  serviceName;
  functionName;
  funcEnvVars;

  constructor(pwd: string, config) {
    const { region, fcEndpoint, access, runtime, initializer, credential, role, logConfig, sharedDirName, downloader,
      uploader, ossUtilUrl, ossBucket, ossKey, ossEndpoint, vpcConfig, nasConfig, srpath, maxMemory, timeout,
      initTimeout, enable, serviceName, functionName, funcEnvVars } = config;
    this.region = region;
    this.runtime = runtime;
    this.initializer = initializer;
    this.defaultCredential = credential;
    this.access = access;
    this.pwd = pwd;
    this.artifactPath = join(process.cwd(), 'target', 'artifact');
    this.targetPath = join(process.cwd(), 'target');
    this.role = role;
    this.logConfig = logConfig;
    this.fcEndpoint = fcEndpoint;
    this.sharedDirName = sharedDirName;
    this.srpath = srpath;
    this.downloader = downloader;
    if (ossEndpoint) {
      this.ossEndpoint = ossEndpoint;
    } else {
      this.ossEndpoint = 'oss-${FC_REGION}-internal.aliyuncs.com'.replace('${FC_REGION}', this.region);
    }
    if (ossUtilUrl) {
      this.ossUtilUrl = ossUtilUrl;
    } else {
      this.ossUtilUrl = OSS_UTIL_URL;
    }

    this.uploader = uploader;
    this.ossBucket = ossBucket;
    this.ossKey = ossKey;
    this.vpcConfig = vpcConfig;
    this.nasConfig = nasConfig;

    if (this.uploader == NAS) {
      this.tmpSrpath = srpath;
    } else {
      this.tmpSrpath = SRPATH;
    }
    this.maxMemory = maxMemory;
    this.timeout = timeout;
    this.initTimeout = initTimeout;
    this.tmpBucketName = `tmp-acceleration-${uuid.v1()}`;
    this.enable = enable;
    this.serviceName = serviceName;
    this.functionName = functionName;
    this.funcEnvVars = funcEnvVars;
  }

  public async gen() {
    if (this.enable) {
      await this.enableQuickStart();
      info("quickstart enabled");
      return;
    }
    info("acceleration function shared dir: " + this.tmpSrpath);
    info("local temp dir: " + tmpDir);
    info("use [" + this.downloader + "] to download acceleration files to local")
    info("use [" + this.uploader + "] to upload acceleration files to fc production")
    if (this.downloader == OSS) {
      info("oss endpoint: " + this.ossEndpoint)
    }
    await this.genDump();
    info("completed");
  }

  async enableQuickStart() {
    info("function environment variables:" + JSON.stringify(this.funcEnvVars));
    if (this.funcEnvVars) {
      this.funcEnvVars['BOOTSTRAP_WRAPPER'] = QUICK_START;
      this.funcEnvVars['SRPATH'] = this.srpath;
    } else {
      this.funcEnvVars = {
        'BOOTSTRAP_WRAPPER': QUICK_START,
        'SRPATH': this.srpath
      }
    }
    const client = await this.getFCClient();
    let res = await client.updateFunction(
        this.serviceName,
        this.functionName,
        {
          environmentVariables: this.funcEnvVars,
        });
    info('update function result: ' + JSON.stringify(res));
  }

  async genDump() {
    await ensureDir(tmpDir);
    const fcClient = await this.getFCClient();
    const tmpServiceName = `${nameBase}-assistant-service`;
    const tmpFunctionName = `${nameBase}-assistant-func`;

    try {
      /* prepare */
      await this.copyFilesForHelperFunc(tmpDir);

      /* create zip file */
      await this.genZip(tmpDir, tmpZipFilePath);

      /* create service */
      await this.createTempService(fcClient, tmpServiceName);

      /* create function */
      await this.createTempFunction(fcClient, tmpServiceName, tmpFunctionName, tmpZipFilePath);

      /* create trigger */
      const tmpTriggerName = `${nameBase}-trigger-${uuid.v1()}`;
      await PythonStartupAcceleration.createTempTrigger(fcClient, tmpServiceName, tmpFunctionName, tmpTriggerName);

      /* generate acceleration files on server */
      await this.genAccelerationFiles(fcClient, tmpServiceName, tmpFunctionName);

      /* download acceleration files to local */
      if (this.uploader != NAS) {
        await this.downloadAccelerationFiles(fcClient, tmpServiceName, tmpFunctionName);
      }
      info('acceleration files generated successfully');

      await this.copyFunctionFiles(this.artifactPath, "user");

      if (this.uploader == OSS) {
        await this.createZipAndUploadToOSS();
      }
    } catch (e) {
      error(e.message);
    } finally {
      /* delete local temp files */
      await remove(tmpDir);
      await remove(tmpZipFilePath);
      await this.removeJavaHelper();

      /* delete temp service and function */
      await this.clearTempObjects(fcClient, tmpServiceName);
      info("acceleration temp files and function deleted");
    }
  }

  private async genAccelerationFiles(fcClient, tmpServiceName: string, tmpFunctionName: string) {
    let archiveFile = ARCHIVE_PATH;

    if (this.uploader == NAS) {
      archiveFile = '';
      let command = 's nas command rm -rf ' + this.tmpSrpath;
      info("clear srctl path before invoking assistant function: [" + command + "]");
      child_process.execSync(command);
    }

    info("invoking assistant function to dump acceleration files");
    let body = 'srpath=' + this.tmpSrpath + ';type=dump;file=' + archiveFile;
    if (this.downloader == OSS) {
      const {ak, secret } = await this.getConfig();
      body += ';accessKeyId=' + ak + ';' +
          'accessKeySecret=' + secret + ';' +
          'endpoint=' + this.ossEndpoint + ';' +
          'bucket=' + this.tmpBucketName;
    } else if (this.downloader == NAS && this.uploader != NAS) {
      let nasFilePath = join(this.nasConfig.mountPoints[0].mountDir, ARCHIVE_NAME);
      body += ';nasFilePath=' + nasFilePath + ';';
    }

    let result = await fcClient.post(`/proxy/${tmpServiceName}/${tmpFunctionName}/invoke`, body);
    let data = result.data;
    info("server messages: " + data)
    if (data.indexOf("success") == 0) {
      info("dumped successfully")
    } else {
      throw new Error("dump encountered error");
    }
  }

  private async downloadAccelerationFiles(fcClient, tmpServiceName: string, tmpFunctionName: string) {
    let sharedDir = join(this.artifactPath, this.sharedDirName);
    await ensureDir(sharedDir);
    let localFile = join(sharedDir, ARCHIVE_NAME);
    if (this.downloader == OSS) {
      await this.downloadByOSS(localFile);
    } else if (this.downloader == NAS) {
      await this.downloadByNAS(localFile);
    } else {
      await PythonStartupAcceleration.download(fcClient, tmpServiceName, tmpFunctionName, localFile);
    }

    await this.extractTar(sharedDir, localFile);
    removeSync(localFile);
  }

  private async createTempFunction(fcClient, tmpServiceName: string, tmpFunctionName: string, tmpZipFilePath: string) {
    await this.uploadToOSSForAssistantFunction(tmpZipFilePath);

    try {
      await fcClient.createFunction(tmpServiceName, {
        description: '',
        functionName: tmpFunctionName,
        handler: TEMP_FUNCTION_HANDLER,
        // initializer: this.initializer,
        memorySize: this.maxMemory,
        instanceType: 'c1',
        runtime: this.runtime,
        timeout: this.timeout, // unit second
        initializationTimeout: this.initTimeout, // unit second
        environmentVariables: {
          SRPATH: this.tmpSrpath
        },
        code: {
          "ossBucketName": this.tmpBucketName,
          "ossObjectName": TEMP_ARCHIVE_NAME,
        }
      });
      info("assistant function created")
    } catch (e) {
      error(e.message);
    } finally {
      await this.removeOSSFileForAssistantFunction();
    }
  }

  private async uploadToOSSForAssistantFunction(tmpZipFilePath) {
    let client = await this.getOSSClient();

    try {
      const result = await client.getBucketInfo(this.tmpBucketName);
      info(sprintflib.sprintf('bucketInfo: %s', result.bucket));
    } catch (e) {
      if (e.name === 'NoSuchBucketError') {
        info(sprintflib.sprintf('bucket: %s does not exist, try to create', this.tmpBucketName));
        const options = {
          storageClass: 'Standard',
          acl: 'private',
          dataRedundancyType: 'LRS'
        }
        await client.putBucket(this.tmpBucketName, options);
        info(sprintflib.sprintf('bucket: %s created', this.tmpBucketName));
      } else {
        error('oss operation error:' + e.message);
        throw error;
      }
    }

    try {
      let client = await this.getOSSClient2(this.tmpBucketName);
      await client.put(TEMP_ARCHIVE_NAME, tmpZipFilePath);
      info('assistant func zip file uploaded to oss');
    } catch (e) {
      error('oss operation error:' + e.message);
      throw e;
    }

    await remove(tmpZipFilePath);
  }

  private async removeOSSFileForAssistantFunction() {
    try {
      let client = await this.getOSSClient2(this.tmpBucketName);
      await client.delete(TEMP_ARCHIVE_NAME);
      info('oss remote file [' + TEMP_ARCHIVE_NAME + '] deleted');

      let list = await client.list();
      if (list.length > 0) {
        throw new Error('oss bucket [' + this.tmpBucketName + '] is not empty');
      }

      await client.deleteBucket(this.tmpBucketName);
      info('oss bucket [' + this.tmpBucketName + '] deleted');
    } catch (e) {
      error('oss operation error:' + e.message);
      throw e;
    }
  }

  private static async createTempTrigger(fcClient, tmpServiceName: string, tmpFunctionName: string, tmpTriggerName: string) {
    await fcClient.createTrigger(tmpServiceName, tmpFunctionName, {
      invocationRole: '',
      qualifier: 'LATEST',
      sourceArn: 'test',
      triggerConfig: {authType: "anonymous", methods: ["POST", "GET"]},
      triggerName: tmpTriggerName,
      triggerType: 'http'
    });
    info("assistant trigger created")
  }

  private async createTempService(fcClient, tmpServiceName) {
    await fcClient.createService(tmpServiceName, {
      description: '用于 Alibaba Dragonwell Acceleration Cache 生成',
      serviceName: tmpServiceName,
      logConfig: this.logConfig,
      role: this.role,
      nasConfig: this.nasConfig,
      vpcConfig: this.vpcConfig,
    });
    info("assistant service created")
  }

  private async getFCClient() {
    const { accountId, ak, secret } = await this.getConfig();
    const fcClient = new FCClientInner(accountId, {
      region: this.region,
      endpoint: this.fcEndpoint,
      accessKeyID: ak,
      accessKeySecret: secret,
      timeout: this.timeout * 1000 // unit millisecond
    });
    return fcClient;
  }

  private async getOSSClient() {
    const { ak, secret } = await this.getConfig();
    return new OSSClient({
      region: 'oss-' + this.region,
      accessKeyId: ak,
      accessKeySecret: secret,
    });
  }

  private async getOSSClient2(bucketName: string) {
    const { ak, secret } = await this.getConfig();
    return new OSSClient({
      region: 'oss-' + this.region,
      accessKeyId: ak,
      accessKeySecret: secret,
      bucket: bucketName,
      timeout: 60 * 2 * 1000
    });
  }

  private async genZip(dir: string, zipFilePath: string) {
    await this.makeZip(dir, zipFilePath);
    copyFileSync(zipFilePath, "/Users/yanglong/Downloads/test/app.zip");
    info("zip file created");
  }

  private async createZipAndUploadToOSS() {
    const tmpZipFilePath = join(tmpdir(), this.ossKey);

    await this.genZip(this.artifactPath, tmpZipFilePath);

    try {
      let client = await this.getOSSClient2(this.ossBucket);

      await client.put(this.ossKey, tmpZipFilePath);
      info('app zip file uploaded to oss');
    } catch (e) {
      error('oss operation error:' + e.message);
      throw e;
    }

    await remove(tmpZipFilePath);
  }

  private async copyFilesForHelperFunc(tmpDir: string) {
    // copy source files
    await copy(join(__dirname, SrctlSourcePath), join(this.pwd, SrctlTargetPath));

    // copy target files
    await this.copyFunctionFiles(tmpDir, "assistant");

    if (this.downloader == OSS) {
      let ossUtilPath = join(tmpDir, OssUtil);
      await this.downloadOssUtil(this.ossUtilUrl, ossUtilPath);
    }

    info('copy files for assistant function completed');
  }

  private async copyFunctionFiles(toDir: string, funcType: string) {
    info("copying files for " + funcType + " function")

    const fileList = await globby([join('code', '**')], {
      onlyFiles: false,
      followSymbolicLinks: false,
      cwd: this.pwd,
      ignore: [
      ],
    });

    await Promise.all(fileList.map(file => {
      const filePath = join(this.pwd, file);
      let targetPath = file.substring(file.indexOf(join("code", path.sep)) + join("code", path.sep).length);
      targetPath = join(toDir, targetPath);
      if (fs.lstatSync(filePath).isDirectory()) {
        return;
      }
      return copySync(filePath, targetPath);
    }));
  }

  private async clearTempObjects(fcClient, tmpServiceName) {
    const { aliases } = (await fcClient.listAliases(tmpServiceName, { limit: 100 })).data;
    await Promise.all(aliases.map(alias => fcClient.deleteAlias(tmpServiceName, alias.aliasName)));

    const { versions } = (await fcClient.listVersions(tmpServiceName, { limit: 100 })).data;
    await Promise.all(versions.map(version => fcClient.deleteVersion(tmpServiceName, version.versionId)));

    const { functions } = (await fcClient.listFunctions(tmpServiceName, { limit: 100 })).data;

    for (const func of functions) {
      const { triggers } = (await fcClient.listTriggers(tmpServiceName, func.functionName, { limit: 100 })).data;
      await Promise.all(triggers.map(trigger => fcClient.deleteTrigger(tmpServiceName, func.functionName, trigger.triggerName)));
    }

    await Promise.all(functions.map(func => fcClient.deleteFunction(tmpServiceName, func.functionName)));

    await fcClient.deleteService(tmpServiceName);
  }

  private static async download(fcClient, tmpServiceName: string, tmpFunctionName: string, localFile: string) {
    let result = await fcClient.post(`/proxy/${tmpServiceName}/${tmpFunctionName}/action`, 'type=size;file=' + ARCHIVE_PATH, null);
    let data = result.data;
    const size = parseInt(data)
    info("archive file size: " + size);

    const partSize = 3 * 1024 * 1024;
    let buffer = Buffer.from('');
    let currentLen = 0;
    while(currentLen < size) {
      let curPartSize = size - currentLen;
      if (curPartSize > partSize) {
        curPartSize = partSize;
      }
      info('download archive start=' + currentLen + ';size=' + curPartSize + ';file=' + ARCHIVE_PATH);
      const result = await fcClient.post(`/proxy/${tmpServiceName}/${tmpFunctionName}/action`,
          'start=' + currentLen + ';size=' + curPartSize + ';file=' + ARCHIVE_PATH, null);
      data = result.data;
      const buf = Buffer.from(data, 'base64');
      buffer = Buffer.concat([buffer, buf]);
      currentLen += curPartSize;
    }

    await writeFile(localFile, buffer);
    return true;
  }

  private async downloadByOSS(localFile: string) {
    let client = await this.getOSSClient2(this.tmpBucketName);

    try {
      await client.get(ARCHIVE_NAME, localFile);
      info('oss file copied to local: ' + localFile);

      await client.delete(ARCHIVE_NAME);
      info('oss remote file [' + ARCHIVE_NAME + '] deleted');

      let list = await client.list();
      if (list.length > 0) {
        throw new Error('oss bucket [' + this.tmpBucketName + '] is not empty');
      }

      await client.deleteBucket(this.tmpBucketName);
      info('oss bucket [' + this.tmpBucketName + '] deleted');
    } catch (e) {
      error('oss operation error:' + e.message);
      throw e;
    }
  }

  private async downloadByNAS(localFile: string) {
    let nasFilePath = join(this.nasConfig.mountPoints[0].mountDir, ARCHIVE_NAME);
    if (existsSync(localFile)) {
      info('before download from nas, remove existing file [' + localFile + ']')
      await remove(localFile);
    }

    let nasCmd = 's nas download ' + nasFilePath + ' ' + localFile;
    try {
      let output = child_process.execSync(nasCmd);
      info(output.toString());
    } catch (e) {
      error('nas operation error:' + e.message);
      throw e;
    }

    if (!existsSync(localFile)) {
      throw new Error('download nas file [' + nasFilePath + '] to local [' + localFile + '] encountered error');
    }

    info('download nas file [' + nasFilePath + '] to local [' + localFile + '] success');
  }

  private async removeJavaHelper() {
    // source files
    await remove(join(this.pwd, SrctlTargetPath));
  }

  private async extractTar(sharedDir: string, tarFile: string) {
    await tar.x({
      cwd: sharedDir,
      file: tarFile
    }).then(() => {
      info("the tar file has been extracted into: " + sharedDir);
    })
  }

  private async makeZip(sourceDirection: string, targetFileName: string) {
    let ignore = [];
    const fileList = await globby(['**'], {
      onlyFiles: false,
      followSymbolicLinks: false,
      cwd: sourceDirection,
      ignore,
    });
    const zip = new JSZip();
    const isWindows = platform() === 'win32';
    for (const fileName of fileList) {
      const absPath = join(sourceDirection, fileName);
      const stats = await lstat(absPath);
      if (stats.isDirectory()) {
        zip.folder(fileName);
      } else if (stats.isSymbolicLink()) {
        let link = await readlink(absPath);
        if (isWindows) {
          link = relative(dirname(absPath), link).replace(/\\/g, '/');
        }
        zip.file(fileName, link, {
          binary: false,
          createFolders: true,
          unixPermissions: stats.mode,
        });
      } else if (stats.isFile()) {
        zip.file(fileName, createReadStream(absPath), {
          binary: true,
          createFolders: true,
          unixPermissions: stats.mode,
        });
      }
    }
    await new Promise((res, rej) => {
      zip
        .generateNodeStream({ platform: 'UNIX' })
        .pipe(createWriteStream(targetFileName))
        .once('finish', res)
        .once('error', rej);
    });
  }

  async getConfig() {
    if (this.defaultCredential) {
      return this.defaultCredential;
    }
    const profDirPath = join(homedir(), '.s');
    const profPath = join(profDirPath, 'access.yaml');
    const isExists = existsSync(profPath);
    let accountId = '';
    let ak = '';
    let secret = '';
    if (isExists) {
      const yamlContent = await readFile(profPath, 'utf-8');
      const yaml: any = YAML.load(yamlContent);
      const config = yaml[this.access ||  Object.keys(yaml)[0]];
      accountId = this.serverlessDevsDecrypt(config.AccountID)
      ak =  this.serverlessDevsDecrypt(config.AccessKeyID);
      secret =  this.serverlessDevsDecrypt(config.AccessKeySecret);
    }

    return {
      accountId, ak, secret
    }
  }

  serverlessDevsDecrypt(value) {
    return Crypto.AES.decrypt(value, ServerlessDevsEncryptKey).toString(Crypto.enc.Utf8);
  }

  async downloadOssUtil(url: string, dest: string) {
    info("start to download [" + url + "]");
    if (existsSync(dest)) {
      info("old file [" + dest + "] deleted");
      await remove(dest);
    }

    await this.downloadUrl(url, dest);

    if (!existsSync(dest)) {
      throw new Error("file [" + dest + "] does not exist");
    }
  };

  async downloadUrl(url: string, dest: string) {
    const pipeline = promisify(stream.pipeline);
    await pipeline(
      got.stream(url),
      fs.createWriteStream(dest)
    ).then(() => {
      info("download [" + url + "] to [" + dest + "] completed");
    }).catch((err) => {
      removeSync(dest);
      error("download [" + url + "] encountered error: " + JSON.stringify(err));
    })
  }
}

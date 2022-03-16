import { tmpdir } from 'os';
import { join } from 'path';
import {
  ensureDir,
  remove,
  copySync, copy, removeSync
} from 'fs-extra';

import * as globby from 'globby';
import * as uuid from 'uuid-1345';
import * as child_process from 'child_process'
import {error, info, NAS, OSS} from "./common";
import * as path from "path";
import * as fs from "fs";
import * as sprintflib from "sprintf-js";
import {
  ARCHIVE_NAME,
  ARCHIVE_PATH,
  LangStartupAcceleration,
  nameBase, OssUtil, SrctlSourcePath, SrctlTargetPath,
  TEMP_FUNCTION_HANDLER,
  tmpDir,
  tmpZipFilePath
} from "./langIndex";

export const TEMP_ARCHIVE_NAME = `tmp-func.zip`;

export class PythonStartupAcceleration extends LangStartupAcceleration {
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
      await remove(join(this.pwd, SrctlTargetPath));

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
    await remove(this.artifactPath);
    info(sprintflib.sprintf("dir [%s] removed", this.artifactPath));
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
        instanceType: this.tmpFunctionInstanceType,
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
    let client = await this.getOSSClient2();

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
      let client = await this.getOSSClient(this.tmpBucketName);
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
      let client = await this.getOSSClient(this.tmpBucketName);
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

  private async createZipAndUploadToOSS() {
    const tmpZipFilePath = join(tmpdir(), this.ossKey);

    await this.genZip(this.artifactPath, tmpZipFilePath);

    try {
      let client = await this.getOSSClient(this.ossBucket);

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
    info("copying files for " + funcType + " function to dir [" + toDir + "]")

    const fileList = await globby([join('code', '**')], {
      onlyFiles: false,
      followSymbolicLinks: false,
      cwd: this.pwd,
      ignore: [
      ],
    });

    await Promise.all(fileList.map(file => {
      const filePath = join(this.pwd, file);
      // info(sprintflib.sprintf("copying %s", filePath))
      if (fs.lstatSync(filePath).isDirectory()) {
        return;
      }

      let targetPath = file.substring(file.indexOf(join("code", path.sep)) + join("code", path.sep).length);
      targetPath = join(toDir, targetPath);
      return copySync(filePath, targetPath);
    }));
  }

  private async downloadByOSS(localFile: string) {
    let client = await this.getOSSClient(this.tmpBucketName);

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
}

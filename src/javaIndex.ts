import { tmpdir } from 'os';
import { join } from 'path';
import {
  ensureDir,
  readFileSync,
  remove,
  copySync, copy, removeSync
} from 'fs-extra';

import * as globby from 'globby';
import * as uuid from 'uuid-1345';
import * as child_process from 'child_process'
import {error, info, NAS, OSS, QUICK_START} from "./common";
import * as path from "path";
import {
  ARCHIVE_NAME,
  ARCHIVE_PATH,
  LangStartupAcceleration,
  nameBase, OssUtil,
  TEMP_FUNCTION_HANDLER,
  tmpDir,
  tmpZipFilePath
} from "./langIndex";
import * as sprintflib from "sprintf-js";

export const AccelerationHelperTargetPath = join('src', 'main', 'java', 'AccelerationHelper.java');
export const AccelerationHelperSourcePath = join('..', 'resources', 'AccelerationHelper.java');

export class JavaStartupAcceleration extends LangStartupAcceleration {
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
    const tmpServiceName = `${nameBase}-service-${uuid.v1()}`;
    const tmpFunctionName = `${nameBase}-func-${uuid.v1()}`;

    try {
      /* prepare */
      await this.buildAndCopyFilesForHelperFunc(tmpDir);

      /* create zip file */
      await this.genZip(tmpDir, tmpZipFilePath);

      /* create service */
      await this.createTempService(fcClient, tmpServiceName);

      /* create function */
      await this.createTempFunction(fcClient, tmpServiceName, tmpFunctionName, tmpZipFilePath);

      /* create trigger */
      const tmpTriggerName = `${nameBase}-trigger-${uuid.v1()}`;
      await JavaStartupAcceleration.createTempTrigger(fcClient, tmpServiceName, tmpFunctionName, tmpTriggerName);

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
    let body = 'srpath=' + this.tmpSrpath + ';type=dump;file=' + archiveFile + ";method=jcmd";
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

    let result = await fcClient.post(`/proxy/${tmpServiceName}/${tmpFunctionName}/action`, body, null);
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
      await JavaStartupAcceleration.download(fcClient, tmpServiceName, tmpFunctionName, localFile);
    }

    await this.extractTar(sharedDir, localFile);
    removeSync(localFile);
  }

  private async createTempFunction(fcClient, tmpServiceName: string, tmpFunctionName: string, tmpZipFilePath: string) {
    let funcConfig = {
      description: '',
      functionName: tmpFunctionName,
      handler: TEMP_FUNCTION_HANDLER,
      initializer: this.initializer,
      instanceType: this.tmpFunctionInstanceType,
      memorySize: this.maxMemory,
      runtime: this.runtime,
      timeout: this.timeout, // unit second
      initializationTimeout: this.initTimeout, // unit second
      environmentVariables: {
        DISABLE_JAVA11_QUICKSTART: 'true',
        BOOTSTRAP_WRAPPER: QUICK_START,
        SRPATH: this.tmpSrpath
      }
    }

    await fcClient.createFunction(tmpServiceName, {
      code: {
        zipFile: readFileSync(tmpZipFilePath, 'base64'),
      },
      ...funcConfig
    });

    info(sprintflib.sprintf("assistant function created: \n%s", JSON.stringify(funcConfig)))
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

  private async buildAndCopyFilesForHelperFunc(tmpDir: string) {
    // copy source files
    await copy(join(__dirname, AccelerationHelperSourcePath), join(this.pwd, AccelerationHelperTargetPath));

    info('building... please wait');

    // compile
    let output = child_process.execSync('mvn clean compile -Dmaven.test.skip=true');
    info(output.toString());

    // download dependencies
    output = child_process.execSync('mvn -DoutputDirectory=' + join(this.targetPath, 'lib') + ' dependency:copy-dependencies');
    info(output.toString());

    // copy target files
    await this.copyFunctionFiles(tmpDir, "assistant");

    if (this.downloader == OSS) {
      let ossUtilPath = join(tmpDir, OssUtil);
      await this.downloadOssUtil(this.ossUtilUrl, ossUtilPath);
    }

    info('build finish');
  }

  private async copyFunctionFiles(toDir: string, funcType: string) {
    info("copying files for " + funcType + " function")

    await copy(join(__dirname, '..', 'resources', 'quickstart.sh'), join(toDir, 'quickstart.sh'));
    await copy(join(__dirname, '..', 'resources', 'classloader-config.xml'), join(toDir, 'sr', 'classloader-config.xml'));

    const fileList = await globby([join('target', '**')], {
      onlyFiles: false,
      followSymbolicLinks: false,
      cwd: this.pwd,
      ignore: [
        join("target", "artifact"),
        join("target", "sr"),
        join("target", "maven*", "**"),
        join("target", "dependency", "**"),
        join("target", "*sources*"),
        join("target", "*sources*", "**")
      ],
    });

    await Promise.all(fileList.map(file => {
      const filePath = join(this.pwd, file);
      if (file == join("target", "classes") || file == join("target", "lib")) {
        return
      }

      let targetPath = file.substring(file.indexOf(join("target", path.sep)) + join("target", path.sep).length);

      let c = join("classes", path.sep);
      if (filePath.indexOf(c) >= 0) {
        targetPath = targetPath.substring(targetPath.indexOf(c) + c.length);
      }

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

  private async removeJavaHelper() {
    // source files
    await remove(join(this.pwd, AccelerationHelperTargetPath));

    // class files
    const Path2 = 'AccelerationHelper.class';
    await remove(join(this.artifactPath, Path2));
  }
}

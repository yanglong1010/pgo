import {dirname, join, relative} from "path";
import {homedir, platform, tmpdir} from "os";
import {error, info, NAS, OSS, OSS_UTIL_URL} from "./common";
import {
    createReadStream,
    createWriteStream,
    existsSync,
    lstat,
    readFile,
    readlink,
    remove,
    removeSync,
    writeFile
} from "fs-extra";
import * as globby from "globby";
import * as JSZip from "jszip";
import {promisify} from "util";
import got from "_got@11.8.3@got";
import * as uuid from 'uuid-1345';
import * as FCClientInner from '@alicloud/fc2';
import * as OSSClient from 'ali-oss';
import * as tar from 'tar';
import * as YAML from 'js-yaml';
import * as child_process from "child_process";
import * as stream from "stream";
import * as fs from "fs";

export const Crypto = require('crypto-js');
export const ServerlessDevsEncryptKey = 'SecretKey123';
export const TMP_PATH = '/tmp';
export const SRCTL = 'srctl';
export const ARCHIVE_NAME = `${SRCTL}.tar.gz`;
export const ARCHIVE_PATH = `${TMP_PATH}/${ARCHIVE_NAME}`;
export const TEMP_FUNCTION_HANDLER = 'AccelerationHelper::handleRequest';
export const nameBase = 'trace-dump';
export const tmpName = `${nameBase}-tmp-${Date.now()}`;
export const tmpDir = join(tmpdir(), tmpName);
export const tmpZipFilePath = join(tmpdir(), `${tmpName}.zip`);
export const OssUtil = "ossutil64";
export const SRPATH = `${TMP_PATH}/runtime.data.share`;
export const SrctlSourcePath = join('..', 'resources', 'srctl');
export const SrctlTargetPath = join('code', 'srctl');

export abstract class LangStartupAcceleration {
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
    tmpFunctionInstanceType;
    builder;

    constructor(pwd: string, config) {
        const { region, fcEndpoint, access, runtime, initializer, credential, role, logConfig, sharedDirName, downloader,
            uploader, ossUtilUrl, ossBucket, ossKey, ossEndpoint, vpcConfig, nasConfig, srpath, maxMemory, timeout,
            initTimeout, enable, serviceName, functionName, funcEnvVars, tmpFunctionInstanceType, builder } = config;
        this.region = region;
        this.runtime = runtime;
        this.initializer = initializer;
        this.defaultCredential = credential;
        this.access = access;
        this.pwd = pwd;
        this.builder = builder;
        this.artifactPath = join(process.cwd(), 'target', 'artifact');
        this.targetPath = join(process.cwd(), 'target');
        this.role = role;
        this.logConfig = logConfig;
        this.fcEndpoint = fcEndpoint;
        this.sharedDirName = sharedDirName;
        this.tmpSrpath = join(TMP_PATH, sharedDirName);
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
        this.tmpFunctionInstanceType = tmpFunctionInstanceType;
    }

    public async gen() {
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

    protected async genDump() {

    }

    protected static async createTempTrigger(fcClient, tmpServiceName: string, tmpFunctionName: string, tmpTriggerName: string) {
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

    protected async createTempService(fcClient, tmpServiceName) {
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

    protected async getFCClient() {
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

    protected async getOSSClient(bucketName: string) {
        const { ak, secret } = await this.getConfig();
        return new OSSClient({
            region: 'oss-' + this.region,
            accessKeyId: ak,
            accessKeySecret: secret,
            bucket: bucketName
        });
    }

    protected async getOSSClient2() {
        const { ak, secret } = await this.getConfig();
        return new OSSClient({
            region: 'oss-' + this.region,
            accessKeyId: ak,
            accessKeySecret: secret,
            timeout: 60 * 2 * 1000
        });
    }

    protected async clearTempObjects(fcClient, tmpServiceName) {
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

    protected static async download(fcClient, tmpServiceName: string, tmpFunctionName: string, localFile: string) {
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

    protected async downloadByNAS(localFile: string) {
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

    protected async extractTar(sharedDir: string, tarFile: string) {
        await tar.x({
            cwd: sharedDir,
            file: tarFile
        }).then(() => {
            info("the tar file has been extracted into: " + sharedDir);
        })
    }

    protected async makeZip(sourceDirection: string, targetFileName: string) {
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

    protected async getConfig() {
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

    protected serverlessDevsDecrypt(value) {
        return Crypto.AES.decrypt(value, ServerlessDevsEncryptKey).toString(Crypto.enc.Utf8);
    }

    protected async downloadOssUtil(url: string, dest: string) {
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

    protected async downloadUrl(url: string, dest: string) {
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

    protected async genZip(dir: string, zipFilePath: string) {
        await this.makeZip(dir, zipFilePath);
        info("zip file created");
    }
}

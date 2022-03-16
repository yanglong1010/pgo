import { platform, tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { ensureDir, copy, lstat, readlink, createWriteStream, move, writeFile, existsSync, readFileSync, remove, readFile } from 'fs-extra';
import { findNpm, installNpm } from '@midwayjs/command-core';
import * as globby from 'globby';
import * as JSZip from 'jszip';
import * as FCClientInner from '@alicloud/fc2';
import * as uuid from 'uuid-1345';

const Crypto = require('crypto-js');
const ServerlessDevsEncryKey = 'SecretKey123';
export class PGO {
  initializer;
  access;
  pwd = process.cwd();
  defaultCredential;
  endpoint;
  region;
  constructor(pwd: string, config) {
    const { access, initializer, credential, endpoint, region } = config
    this.initializer = initializer;
    this.defaultCredential = credential;
    this.access = access;
    this.pwd = pwd;
    this.endpoint = endpoint;
    this.region = region;
  }

  public async gen(args?) {
    await this.genDump(args);
  }

  async genDump(args) {
    const pkgJsonFIle = join(this.pwd, 'package.json');
    if (!existsSync(pkgJsonFIle)) {
      console.log('无 package.json 文件，跳过 Alinode PGO 生成');
      return;
    }
    // 需要指定 index.initializer
    // 将用户代码拷贝到一个临时目录
    const pgoFunctionName = `nodePGOGen`;
    const tmpName = `${pgoFunctionName}-${Date.now()}`;
    const tmpDir = join(tmpdir(), tmpName);
    await ensureDir(tmpDir);
    const entry = this.initializer.split('.');

    // 拷贝 pgo 工具库
    await copy(join(__dirname, '../pgoCommonUtils.js'), join(this.pwd, 'pgoCommonUtils.js'));
    // 将入口迁移
    const entryFile = join(this.pwd, entry[0] + '.js');
    const initializerFun = entry[1] || 'initializer';
    const entryOriginFile = join(this.pwd, entry[0] + '_pgo_origin.js');
    if (!existsSync(entryOriginFile)) {
      await move(entryFile, join(this.pwd, entry[0] + '_pgo_origin.js'));
      // 重写入口
      await writeFile(entryFile, `// Generated by Alibaba Node.js PGO
const pgo = require('./pgoCommonUtils.js');
pgo.start();
const originModule = require('./index_pgo_origin.js');
Object.assign(exports, originModule);
exports.${initializerFun} = async (context, callback) => {
  const originCallback = callback;
  callback = (...args) => {
    pgo.end();
    originCallback(...args);
  };
  if (originModule['${initializerFun}']) {
    originModule['${initializerFun}'](context, callback);
  } else {
    callback(null, '');
  }
};`);
    }

    // 拷贝所有文件
    const fileList = await globby(['**'], {
      onlyFiles: false,
      followSymbolicLinks: false,
      cwd: this.pwd,
      ignore: [
        '**/node_modules/**'
      ],
    });





    await Promise.all(fileList.map(file => {
      const filePath = join(this.pwd, file);
      const targetPath = join(tmpDir, file);
      return copy(filePath, targetPath);
    }));

    const targetRRC = join(tmpDir, 'require_cache.strrc');
    if (existsSync(targetRRC)) {
      await remove(targetRRC);
    }

    // 将 dryRun 写入入口文件
    const tmpEntry = join(tmpDir, entry[0] + '.js');
    await writeFile(tmpEntry, readFileSync(tmpEntry, 'utf-8') + `/* */exports.alinode_pgo_dry_run = (event, context, callback) => callback(null, pgo.info(event));`);
    // 安装production依赖
    const { npm, registry } = findNpm();
    await installNpm({
      baseDir: tmpDir,
      register: npm,
      registerPath: registry,
      mode: ['production']
    });

    // 打包生成zip
    console.log('PGO tmp function zipping...')
    const tmpZipFile = `${tmpName}.zip`;
    const tmpZipFilePath = join(tmpdir(), tmpZipFile);
    await this.makeZip(tmpDir, tmpZipFilePath);

    // 获取阿里云账号信息
    const { accountId, ak, secret } = this.defaultCredential;
    const fcClient = new FCClientInner(accountId, {
      region: this.region,
      endpoint: this.endpoint,
      accessKeyID: ak,
      accessKeySecret: secret,
    });

    // 创建临时函数
    // 创建临时 servive
    const serviceName = `nodejs-pgo-${uuid.v1()}`;
    await fcClient.createService(serviceName, {
      description: '用于 Alinode Cloud Require Cache 生成',
    });

    const functionName = `dump-${uuid.v1()}`;

    console.log('PGO create tmp function...')
    // 创建函数
    await fcClient.createFunction(serviceName, {
      code: {
        zipFile: readFileSync(tmpZipFilePath, 'base64'),
      },
      description: '',
      functionName,
      handler: `${entry[0]}.alinode_pgo_dry_run`,
      initializer: this.initializer,
      memorySize: 1024,
      runtime: 'nodejs14',
      timeout: 300,
      initializationTimeout: 300,
      environmentVariables: {
        PGO_RECORD: 'true',
        NODE_ENV: 'development',
      },
    });

    // 移除临时文件
    // await remove(tmpDir);
    // await remove(tmpZipFilePath);

    console.log('PGO rrc downloading...')

    // 生成并下载 rrc 文件
    const result = await fcClient.invokeFunction(serviceName, functionName, JSON.stringify({type: 'size'}));
    if (!result.data || !/^\d+$/.test(result.data)) {
      console.log('result.data', result.data);
      throw new Error(`PGO gen error:` + (result.data || 'unknown'));
    }
    const size = +result.data;
    const partSize = 3 * 1024 * 1024;
    let buffer = Buffer.from('');
    let currentLen = 0;
    while(currentLen < size) {
      let curPartSize = size - currentLen;
      if (curPartSize > partSize) {
        curPartSize = partSize;
      }
      const result = await fcClient.invokeFunction(serviceName, functionName, JSON.stringify({start: currentLen, size: partSize}));
      const buf = Buffer.from(result.data, 'base64');
      buffer = Buffer.concat([buffer, buf]);
      currentLen += curPartSize;
    }

    const pgorrc = join(this.pwd, 'require_cache.strrc');
    await writeFile(pgorrc, buffer);
    // 清理
    // 列出该 Service 的 Alias 并删除
    const { aliases } = (await fcClient.listAliases(serviceName, { limit: 100 })).data;
    await Promise.all(aliases.map(alias => fcClient.deleteAlias(serviceName, alias.aliasName)));

    // 列出该 Service 的 Version 并删除
    const { versions } = (await fcClient.listVersions(serviceName, { limit: 100 })).data;
    await Promise.all(versions.map(version => fcClient.deleteVersion(serviceName, version.versionId)));

    // 列出该 Service 的函数并删除
    const { functions } = (await fcClient.listFunctions(serviceName, { limit: 100 })).data;
    await Promise.all(functions.map(func => fcClient.deleteFunction(serviceName, func.functionName)));

    // 删除 Service
    await fcClient.deleteService(serviceName);

    const nm = join(this.pwd, 'node_modules');
    if (args?.['remove-nm'] && existsSync(nm)) {
      await remove(nm);
    }
    console.log('PGO Generated');
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
        const fileData = await readFile(absPath);
        zip.file(fileName, fileData, {
          binary: true,
          createFolders: true,
          unixPermissions: stats.mode,
        });
      }
    }
    await new Promise((res, rej) => {
      zip
        .generateNodeStream({
          platform: 'UNIX',
          compression: 'DEFLATE',
          compressionOptions: {
              level: 6
          }
        })
        .pipe(createWriteStream(targetFileName))
        .once('finish', res)
        .once('error', rej);
    });
  }

  serverlessDevsDecrypt(value) {
    return Crypto.AES.decrypt(value, ServerlessDevsEncryKey).toString(Crypto.enc.Utf8);
  }
}

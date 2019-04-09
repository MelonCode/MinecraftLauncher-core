const fs = require('fs');
const shelljs = require('shelljs');
const path = require('path');
const request = require('request');
const zip = require('adm-zip');
const event = require('./events');
const crypto = require('crypto');

let dCount = 0;
let dSize = 0;
let totalCount = 0;

function downloadAsync(url, directory, name) {
  return new Promise(resolve => {
    shelljs.mkdir('-p', directory);

    const _request = request(url, { timeout: 3000 });

    _request.on('error', function(error) {
      resolve({
        failed: true,
        asset: {
          url: url,
          directory: directory,
          name: name
        }
      });
    });

    _request.on('data', data => {
      let size = 0;
      if (fs.existsSync(path.join(directory, name)))
        size = fs.statSync(path.join(directory, name))['size'];
      event.emit('download-status', {
        name: name,
        current: Math.round(size / 10000),
        total: data.length
      });
    });

    const file = fs.createWriteStream(path.join(directory, name));
    _request.pipe(file);

    file.once('finish', function() {
      event.emit('download', name);
      resolve({ failed: false, asset: null });
    });
  });
}

const downloadAsset = (url, directory, name) => {
  return new Promise((resolve, reject) => {
    const filePath = path.join(directory, name);

    shelljs.mkdir('-p', directory);
    const download = request(url, { timeout: 3000 });
    const file = fs.createWriteStream(filePath);
    download.pipe(file);

    download.on('error', error => {
      file.close();
      return resolve({ success: false, url, directory, name, error });
    });

    file.once('finish', () => {
      file.close();
      return resolve({ success: true, file, url, directory, name });
    });
  });
};

module.exports.getVersion = function(version, directory) {
  return new Promise(resolve => {
    if (fs.existsSync(path.join(directory, `${version}.json`)))
      resolve(require(path.join(directory, `${version}.json`)));

    const manifest =
      'https://launchermeta.mojang.com/mc/game/version_manifest.json';
    request.get(manifest, function(error, response, body) {
      if (error) resolve(error);

      const parsed = JSON.parse(body);

      for (const desiredVersion in parsed.versions) {
        if (parsed.versions[desiredVersion].id === version) {
          request.get(parsed.versions[desiredVersion].url, function(
            error,
            response,
            body
          ) {
            if (error) resolve(error);

            resolve(JSON.parse(body));
          });
        }
      }
    });
  });
};

module.exports.getJar = function(version, number, directory) {
  return new Promise(async resolve => {
    await downloadAsync(
      version.downloads.client.url,
      directory,
      `${number}.jar`
    );

    fs.writeFileSync(
      path.join(directory, `${number}.json`),
      JSON.stringify(version, null, 4)
    );

    resolve();
  });
};

function chunk(list, chunkSize = 10) {
  if (!list.length) {
    return [];
  }

  let i,
    j,
    t,
    chunks = [];
  for (i = 0, j = list.length; i < j; i += chunkSize) {
    t = list.slice(i, i + chunkSize);
    chunks.push(t);
  }

  return chunks;
}

const assetsUrl = 'https://resources.download.minecraft.net';

function checksumFile(path) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) return reject('File not found');
    let hash = crypto.createHash('sha1');
    let stream = fs.createReadStream(path);
    stream.on('error', err => reject(err));
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function downloadAssets(directory, assets) {
  const failedAssets = {};
  const totalSize = Object.values(assets).reduce(
    (acc, curr) => (acc += curr.size),
    0
  );
  console.log(
    `Downloading ${
      Object.keys(assets).length
    } assets with total size ${totalSize}`
  );

  await Promise.all(
    Object.entries(assets).map(async ([name, { hash, size }]) => {
      const subhash = hash.substring(0, 2);
      const assetDirectory = path.join(directory, 'assets', 'objects', subhash);
      const url = `${assetsUrl}/${subhash}/${hash}`;
      const filePath = path.resolve(assetDirectory, hash);
      if (!fs.existsSync(filePath) || fs.statSync(filePath)['size'] === 0) {
        const result = await downloadAsync(url, assetDirectory, hash);
        const { success } = result;
        if (success) {
          const percentage = Math.round((dSize / totalSize) * 100);
          console.log(
            `Downloaded asset (${dCount} / ${totalCount}) | ${percentage}% ${name} as ${assetDirectory}/${hash}`
          );
        } else {
          failedAssets[name] = { hash, size };
          // console
          //   .warn
          //   `Failed to download ${name} from ${url} as ${assetDirectory}//${hash}`
          //   ();
          return;
        }
      }

      try {
        const fileHash = await checksumFile(path.join(assetDirectory, hash));
        if (fileHash === hash) {
          dCount += 1;
          dSize += size;
          event.emit('assets-download-status', {
            dCount,
            totalCount,
            name
          });
          console.log(
            `Checking file ${name}. Required hash ${hash} is equal to file hash ${fileHash}`
          );
        } else {
          failedAssets[name] = { hash, size };
          console.warn(
            `Failed to download ${name} as ${assetDirectory}/${hash}; Hashsum is different from expected`
          );
          shelljs.rm(path.resolve(assetDirectory, hash));
        }
      } catch (error) {
        failedAssets[name] = { hash, size };
        console.error(
          `Failed to validate checksum of ${name} in ${assetDirectory}/${hash}`,
          error
        );
        shelljs.rm(path.resolve(assetDirectory, hash));
      }
    })
  ).catch(error => {
    console.error('Unpredictable error!', error);
  });

  return failedAssets;
}

module.exports.getAssets = function(directory, version) {
  return new Promise(async resolve => {
    dCount = 0;
    dSize = 0;

    event.emit('assets-download-start');

    if (
      !fs.existsSync(
        path.join(
          directory,
          'assets',
          'indexes',
          `${version.assetIndex.id}.json`
        )
      )
    ) {
      await downloadAsset(
        version.assetIndex.url,
        path.join(directory, 'assets', 'indexes'),
        `${version.assetIndex.id}.json`
      );
    }

    const index = require(path.join(
      directory,
      'assets',
      'indexes',
      `${version.assetIndex.id}.json`
    ));

    let assets = index.objects;
    totalCount = Object.keys(assets).length;
    totalSize = Object.values(assets).reduce(
      (acc, curr) => (acc += curr.size),
      0
    );
    let tries = 0;
    do {
      assets = await downloadAssets(directory, assets);
      tries++;
      console.log(`Failed to download ${Object.entries(assets).length} files`);
    } while (Object.entries(assets).length > 0);
    console.log(`Finished! Repeated download ${tries} time(s)`);

    resolve();
  });
};

module.exports.getNatives = function(root, version, os) {
  return new Promise(async resolve => {
    let nativeDirectory;

    if (fs.existsSync(path.join(root, 'natives', version.id))) {
      nativeDirectory = path.join(root, 'natives', version.id);
    } else {
      nativeDirectory = path.join(root, 'natives', version.id);

      shelljs.mkdir('-p', nativeDirectory);

      const download = version.libraries.map(async function(lib) {
        if (!lib.downloads.classifiers) return;
        const type = `natives-${os}`;
        const native = lib.downloads.classifiers[type];

        if (native) {
          const name = native.path.split('/').pop();
          await downloadAsync(native.url, nativeDirectory, name);
          try {
            new zip(path.join(nativeDirectory, name)).extractAllTo(
              nativeDirectory,
              true
            );
          } catch (e) {
            // Only doing a console.warn since a stupid error happens. You can basically ignore this.
            // if it says Invalid file name, just means two files were downloaded and both were deleted.
            // All is well.
            console.warn(e);
          }
          shelljs.rm(path.join(nativeDirectory, name));
        }
      });

      await Promise.all(download);
    }

    resolve(nativeDirectory);
  });
};

module.exports.getForgeDependencies = async function(
  root,
  version,
  forgeJarPath
) {
  if (!fs.existsSync(path.join(root, 'forge'))) {
    shelljs.mkdir('-p', path.join(root, 'forge'));
  }
  await new zip(forgeJarPath).extractEntryTo(
    'version.json',
    path.join(root, 'forge', `${version.id}`),
    false,
    true
  );

  const forge = require(path.join(
    root,
    'forge',
    `${version.id}`,
    'version.json'
  ));
  const forgeLibs = forge.libraries;
  const mavenUrl = 'http://files.minecraftforge.net/maven/';
  const defaultRepo = 'https://libraries.minecraft.net/';
  const paths = [];

  const download = forgeLibs.map(async library => {
    const lib = library.name.split(':');

    if (lib[0] === 'net.minecraftforge' && lib[1].includes('forge')) return;

    let url = mavenUrl;
    const jarPath = path.join(
      root,
      'libraries',
      `${lib[0].replace(/\./g, '/')}/${lib[1]}/${lib[2]}`
    );
    const name = `${lib[1]}-${lib[2]}.jar`;

    if (!library.url) {
      if (library.serverreq || library.clientreq) {
        url = defaultRepo;
      } else {
        return;
      }
    }

    const downloadLink = `${url}${lib[0].replace(/\./g, '/')}/${lib[1]}/${
      lib[2]
    }/${lib[1]}-${lib[2]}.jar`;

    if (fs.existsSync(path.join(jarPath, name))) {
      paths.push(`${jarPath}\\${name}`);
      return;
    }
    if (!fs.existsSync(jarPath)) shelljs.mkdir('-p', jarPath);

    await downloadAsync(downloadLink, jarPath, name);

    paths.push(`${jarPath}\\${name}`);
  });

  await Promise.all(download);

  return { paths, forge };
};

module.exports.getClasses = function(root, version) {
  return new Promise(async resolve => {
    const libs = [];

    const libraries = version.libraries.map(async _lib => {
      if (!_lib.downloads.artifact) return;

      const libraryPath = _lib.downloads.artifact.path;
      const libraryUrl = _lib.downloads.artifact.url;
      const libraryDirectory = path.join(root, 'libraries', libraryPath);

      if (!fs.existsSync(libraryDirectory)) {
        let directory = libraryDirectory.split('\\');
        const name = directory.pop();
        directory = directory.join('\\');

        await downloadAsync(libraryUrl, directory, name);
      }

      libs.push(libraryDirectory);
    });

    await Promise.all(libraries);

    resolve(libs);
  });
};

module.exports.getLaunchOptions = function(version, forge, options) {
  return new Promise(resolve => {
    const type = forge || version;
    const arguments = type.minecraftArguments
      ? type.minecraftArguments.split(' ')
      : type.arguments.game;
    const assetPath =
      version.assets === 'legacy' || version.assets === 'pre-1.6'
        ? path.join(options.root, 'assets', 'legacy')
        : path.join(options.root, 'assets');

    const fields = {
      '${auth_access_token}': options.authorization.access_token,
      '${auth_session}': options.authorization.access_token,
      '${auth_player_name}': options.authorization.name,
      '${auth_uuid}': options.authorization.uuid,
      '${user_properties}': options.authorization.user_properties,
      '${user_type}': 'mojang',
      '${version_name}': options.version.number,
      '${assets_index_name}': version.assetIndex.id,
      '${game_directory}': path.join(options.root),
      '${assets_root}': assetPath,
      '${game_assets}': assetPath,
      '${version_type}': options.version.type
    };

    for (let index = 0; index < arguments.length; index++) {
      if (Object.keys(fields).includes(arguments[index])) {
        arguments[index] = fields[arguments[index]];
      }
    }

    if (options.server)
      arguments.push(
        '--server',
        options.server.host,
        '--port',
        options.server.port || '25565'
      );
    if (options.proxy)
      arguments.push(
        '--proxyHost',
        options.proxy.host,
        '--proxyPort',
        options.proxy.port || '8080',
        '--proxyUser',
        options.proxy.username,
        '--proxyPass',
        options.proxy.password
      );

    resolve(arguments);
  });
};

module.exports.getJVM = function(version, options) {
  return new Promise(resolve => {
    switch (options.os) {
      case 'windows': {
        resolve(
          '-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump'
        );
        break;
      }
      case 'osx': {
        resolve('-XstartOnFirstThread');
        break;
      }
      case 'linux': {
        resolve('-Xss1M');
        break;
      }
    }
  });
};

module.exports.makePackage = async function(versions, os) {
  const directory = path.join(process.cwd(), 'clientpackage');

  for (const version in versions) {
    const versionFile = await this.getVersion(versions[version], directory);
    await this.getNatives(
      `${directory}/natives/${versions[version]}`,
      versionFile,
      os,
      true
    );
    await this.getJar(
      versionFile,
      versions[version],
      `${directory}/versions/${versions[version]}`
    );
    await this.getClasses(directory, versionFile);
    await this.getAssets(directory, versionFile);
  }

  const archive = new zip();
  archive.addLocalFolder(directory);
  archive.writeZip(`${directory}.zip`);
};

module.exports.extractPackage = function(root, clientPackage) {
  return new Promise(async resolve => {
    if (clientPackage.startsWith('http')) {
      await downloadAsync(clientPackage, root, 'clientPackage.zip');
      clientPackage = path.join(root, 'clientPackage.zip');
    }
    new zip(clientPackage).extractAllTo(root, true);
    event.emit('package-extract', true);
    resolve();
  });
};

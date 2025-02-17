const _ = global._;
const Q = require('bluebird');
const fs = require('fs');
const { app, dialog } = require('electron');
const got = require('got');
const path = require('path');
const Settings = require('./settings');
const Windows = require('./windows');
const ClientBinaryManager = require('./seroClientBinaries').Manager;
const EventEmitter = require('events').EventEmitter;
// const spawn = require('child_process').spawn;

const log = require('./utils/logger').create('ClientBinaryManager');

// should be       'https://raw.githubusercontent.com/ethereum/mist/master/clientBinaries.json'
// const BINARY_URL = 'http://sero-media.s3-website-ap-southeast-1.amazonaws.com/clients/clientBinaries.json';
const BINARY_URL = 'https://sero-media-1256272584.cos.ap-shanghai.myqcloud.com/wallet/clientBinaries.json';

// const ALLOWED_DOWNLOAD_URLSopen_REGEX =
//     /^https:\/\/(?:(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)?ethereum\.org\/|gethstore\.blob\.core\.windows\.net\/|bintray\.com\/artifact\/download\/karalabe\/ethereum\/)(?:.+)/;  // eslint-disable-line max-len

class Manager extends EventEmitter {
    constructor() {
        super();

        this._availableClients = {};
        this.BINARY_URL = '';

    }

    init(restart) {
        log.info('Initializing...');

        // check every hour
        setInterval(() => this._checkForNewConfig(true), 1000 * 60 * 60);
        this.BINARY_URL = BINARY_URL;
        return this._checkForNewConfig(restart);
    }

    getClient(clientId) {
        return this._availableClients[clientId.toLowerCase()];
    }

    getBINARYURL(){
        return this.BINARY_URL
    }


    _writeLocalConfig(json) {
        log.info('Write new client binaries local config to disk ...');

        fs.writeFileSync(
            path.join(Settings.userDataPath, 'clientBinaries.json'),
            JSON.stringify(json, null, 2)
        );
    }

    _checkForNewConfig(restart) {
        const nodeType = 'gero';
        let binariesDownloaded = false;
        let nodeInfo;

        log.info(`Checking for new client binaries config from: ${BINARY_URL}`);

        this._emit('loadConfig', 'Fetching remote client config');

        // fetch config
        return got(BINARY_URL, {
            timeout: 3000,
            json: true,
        })
        .then((res) => {
            if (!res || _.isEmpty(res.body)) {
                throw new Error('Invalid fetch result');
            } else {
                return res.body;
            }
        })
        .catch((err) => {
            log.warn('Error fetching client binaries config from repo', err);
        })
        .then((latestConfig) => {
            if (!latestConfig) return;

            log.info('latestConfig:::',latestConfig);
            let localConfig;
            // let skipedVersion;
            const nodeVersion = latestConfig.clients[nodeType].version;

            this._emit('loadConfig', 'Fetching local config');

            try {
                // now load the local json
                localConfig = JSON.parse(
                    fs.readFileSync(path.join(Settings.userDataPath, 'clientBinaries.json')).toString()
                );
            } catch (err) {
                log.warn(`Error loading local config - assuming this is a first run: ${err}`);

                if (latestConfig) {
                    localConfig = latestConfig;

                    this._writeLocalConfig(localConfig);
                } else {
                    throw new Error('Unable to load local or remote config, cannot proceed!');
                }
            }

            // try {
            //     skipedVersion = fs.readFileSync(path.join(Settings.userDataPath, 'skippedNodeVersion.json')).toString();
            // } catch (err) {
            //     log.info('No "skippedNodeVersion.json" found.');
            // }


            // prepare node info
            const platform = process.platform.replace('darwin', 'mac').replace('win32', 'win').replace('freebsd', 'linux').replace('sunos', 'linux');


            const binaryVersion = latestConfig.clients[nodeType].platforms[platform][process.arch];
            const checksums = _.pick(binaryVersion.download, 'sha256', 'md5');
            const algorithm = _.keys(checksums)[0].toUpperCase();
            const hash = _.values(checksums)[0];

            // get the node data, to be able to pass it to a possible error
            nodeInfo = {
                type: nodeType,
                version: nodeVersion,
                checksum: hash,
                algorithm,
            };

            if (latestConfig
                && JSON.stringify(localConfig) !== JSON.stringify(latestConfig)
                // && nodeVersion !== skipedVersion
            ) {

                return new Q((resolve) => {

                    log.debug('New client binaries config found, asking user if they wish to update...');
                    resolve(latestConfig);

                    // const wnd = Windows.createPopup('clientUpdateAvailable', _.extend({
                    //     useWeb3: false,
                    //     electronOptions: {
                    //         width: 600,
                    //         height: 340,
                    //         alwaysOnTop: false,
                    //         resizable: false,
                    //         maximizable: false,
                    //     },
                    // }, {
                    //     sendData: {
                    //         uiAction_sendData: {
                    //             name: nodeType,
                    //             version: nodeVersion,
                    //             checksum: `${algorithm}: ${hash}`,
                    //             downloadUrl: binaryVersion.download.url,
                    //             restart,
                    //         },
                    //     },
                    // }), (update) => {
                    //     // update
                    //     if (update === 'update') {
                    //         this._writeLocalConfig(latestConfig);
                    //
                    //         resolve(latestConfig);
                    //
                    //     // skip
                    //     } else if (update === 'skip') {
                    //         // fs.writeFileSync(
                    //         //     path.join(Settings.userDataPath, 'skippedNodeVersion.json'),
                    //         //     nodeVersion
                    //         // );
                    //
                    //         resolve(localConfig);
                    //     }
                    //
                    //     wnd.close();
                    // });
                    //
                    // // if the window is closed, simply continue and as again next time
                    // wnd.on('close', () => {
                    //     resolve(localConfig);
                    // });
                });
            }

            return localConfig;
        }).then((localConfig) => {
            if (!localConfig) {
                log.info('No config for the ClientBinaryManager could be loaded, using local clientBinaries.json.');

                const localConfigPath = path.join(Settings.userDataPath, 'clientBinaries.json');
                localConfig = (fs.existsSync(localConfigPath)) ? require(localConfigPath) : require('../clientBinaries.json');  // eslint-disable-line no-param-reassign, global-require, import/no-dynamic-require, import/no-unresolved
            }

            // scan for node
            const mgr = new ClientBinaryManager(localConfig);

            mgr.on('progress',(progress) => {
                var that = this;
                that._emit('downloading', 'Downloading binaries' ,progress);
            })

            mgr.logger = log;

            this._emit('scanning', 'Scanning for binaries');

            return mgr.init({
                folders: [
                    path.join(Settings.userDataPath, 'binaries', 'gero', 'unpacked'),
                    // path.join(Settings.userDataPath, 'binaries', 'sero', 'unpacked'),
                ],
            })
            .then(() => {
                const clients = mgr.clients;

                this._availableClients = {};

                const available = _.filter(clients, c => !!c.state.available);

                if (!available.length) {
                    if (_.isEmpty(clients)) {
                        throw new Error('No client binaries available for this system!');
                    }

                    this._emit('downloading', 'Downloading binaries');

                    return Q.map(_.values(clients), (c) => {
                        binariesDownloaded = true;
                        return mgr.download(c.id, {
                            downloadFolder: path.join(Settings.userDataPath, 'binaries'),
                            // urlRegex: ALLOWED_DOWNLOAD_URLS_REGEX,
                        });
                    });
                }
            })
            .then(() => {
                this._emit('filtering', 'Filtering available clients');

                _.each(mgr.clients, (client) => {
                    if (client.state.available) {
                        const idlcase = client.id.toLowerCase();
                        log.info('Settings[`${idlcase}Path`:::',idlcase);
                        this._availableClients[idlcase] = {
                            binPath: Settings[`${idlcase}Path`] || client.activeCli.fullPath,
                            version: client.version,
                        };
                    }
                });

                // restart if it downloaded while running
                if (restart && binariesDownloaded) {
                    log.info('Restarting app ...');
                    app.relaunch();
                    app.quit();
                }

                this._emit('done');
            });
        })
        .catch((err) => {
            log.error(err);

            this._emit('error', err.message);

            // show error
            if (err.message.indexOf('Hash mismatch') !== -1) {
                // show hash mismatch error
                dialog.showMessageBox({
                    type: 'warning',
                    buttons: ['OK'],
                    message: global.i18n.t('mist.errors.nodeChecksumMismatch.title'),
                    detail: global.i18n.t('mist.errors.nodeChecksumMismatch.description', {
                        type: nodeInfo.type,
                        version: nodeInfo.version,
                        algorithm: nodeInfo.algorithm,
                        hash: nodeInfo.checksum,
                    }),
                }, () => {
                    app.quit();
                });

                // throw so the main.js can catch it
                throw err;
            }else if(err.message.indexOf('locked') > -1){
                log.info('Restarting app ...');
                app.relaunch();
                app.quit();
            }

        });
    }


    _emit(status, msg ,progress) {
        log.debug(`Status: ${status} - ${msg} - ${progress}`);

        this.emit('status', status, msg ,progress);
    }



}


module.exports = new Manager();

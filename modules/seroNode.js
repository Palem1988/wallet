const _ = global._;
const fs = require('fs');
const Q = require('bluebird');
const spawn = require('child_process').spawn;
const { dialog } = require('electron');
const Windows = require('./windows.js');
const Settings = require('./settings');
const log = require('./utils/logger').create('SeroNode');
const logRotate = require('log-rotate');
const EventEmitter = require('events').EventEmitter;
const Sockets = require('./socketManager');
const ClientBinaryManager = require('./clientBinaryManager');

const DEFAULT_NODE_TYPE = 'gero';
const DEFAULT_NETWORK = 'beta';
const DEFAULT_SYNCMODE = 'full';

const UNABLE_TO_BIND_PORT_ERROR = 'unableToBindPort';
const NODE_START_WAIT_MS = 3000;

const STATES = {
    STARTING: 0, /* Node about to be started */
    STARTED: 1, /* Node started */
    CONNECTED: 2, /* IPC connected - all ready */
    STOPPING: 3, /* Node about to be stopped */
    STOPPED: 4, /* Node stopped */
    ERROR: -1, /* Unexpected error */
};

/**
 * Sero nodes manager.
 */
class SeroNode extends EventEmitter {
    constructor() {
        super();

        this.STATES = STATES;

        this._loadDefaults();

        this._node = null;
        this._type = null;
        this._network = null;

        this._socket = Sockets.get('node-ipc', Settings.rpcMode);

        this.on('data', _.bind(this._logNodeData, this));
    }

    get isOwnNode() {
        return !!this._node;
    }

    get isExternalNode() {
        return !this._node;
    }

    get isIpcConnected() {
        return this._socket.isConnected;
    }

    get type() {
        return this.isOwnNode ? this._type : null;
    }

    get network() {
        return this.isOwnNode ? this._network : null;
    }

    get syncMode() {
        return this._syncMode;
    }

    get isSero() {
        return this._type === 'sero';
    }

    get isGero() {
        return this._type === 'gero';
    }

    get isMainNetwork() {
        return this.network === 'main';
    }

    get isBetaNetwork() {
        return this.network === 'beta';
    }

    get isAlphaNetwork() {
        return this.network === 'alpha';
    }

    get isDevNetwork() {
        return this.network === 'dev';
    }

    get state() {
        return this._state;
    }

    get stateAsText() {
        switch (this._state) {
        case STATES.STARTING:
            return 'starting';
        case STATES.STARTED:
            return 'started';
        case STATES.CONNECTED:
            return 'connected';
        case STATES.STOPPING:
            return 'stopping';
        case STATES.STOPPED:
            return 'stopped';
        case STATES.ERROR:
            return 'error';
        default:
            return false;
        }
    }

    set state(newState) {
        this._state = newState;

        this.emit('state', this.state, this.stateAsText);
    }

    get lastError() {
        return this._lastErr;
    }

    set lastError(err) {
        this._lastErr = err;
    }

    /**
     * This method should always be called first to initialise the connection.
     * @return {Promise}
     */
    init() {
        return this._socket.connect(Settings.rpcConnectConfig)
            .then(() => {
                this.state = STATES.CONNECTED;

                this.emit('runningNodeFound');
            })
            .catch(() => {
                log.warn('Failed to connect to node. Maybe it\'s not running so let\'s start our own...');

                log.info(`Node type: ${this.defaultNodeType}`);
                log.info(`Network: ${this.defaultNetwork}`);
                log.info(`SyncMode: ${this.defaultSyncMode}`);

                // if not, start node yourself
                return this._start(this.defaultNodeType, this.defaultNetwork, this.defaultSyncMode)
                    .catch((err) => {
                        log.error('Failed to start node', err);
                        throw err;
                    });
            });
    }


    restart(newType, newNetwork, syncMode) {
        return Q.try(() => {
            if (!this.isOwnNode) {
                throw new Error('Cannot restart node since it was started externally');
            }

            log.info('Restart node', newType, newNetwork);

            return this.stop()
                .then(() => Windows.loading.show())
                .then(() => this._start(
                      newType || this.type,
                      newNetwork || this.network,
                      syncMode || this.syncMode
                    ))
                .then(() => Windows.loading.hide())
                .catch((err) => {
                    log.error('Error restarting node', err);
                    throw err;
                });
        });
    }


    /**
     * Stop node.
     *
     * @return {Promise}
     */
    stop() {
        if (!this._stopPromise) {
            return new Q((resolve) => {
                if (!this._node) {
                    return resolve();
                }

                this.state = STATES.STOPPING;

                log.info(`Stopping existing node: ${this._type} ${this._network}`);

                this._node.stderr.removeAllListeners('data');
                this._node.stdout.removeAllListeners('data');
                this._node.stdin.removeAllListeners('error');
                this._node.removeAllListeners('error');
                this._node.removeAllListeners('exit');

                this._node.kill('SIGINT');

                // after some time just kill it if not already done so
                const killTimeout = setTimeout(() => {
                    if (this._node) {
                        this._node.kill('SIGKILL');
                    }
                }, 8000 /* 8 seconds */);

                this._node.once('close', () => {
                    clearTimeout(killTimeout);

                    this._node = null;

                    resolve();
                });
            })
            .then(() => {
                this.state = STATES.STOPPED;
                this._stopPromise = null;
            });
        }
        log.debug('Disconnection already in progress, returning Promise.');
        return this._stopPromise;
    }

    getLog() {
        return Settings.loadUserData('node.log');
    }

    /**
     * Send Web3 command to socket.
     * @param  {String} method Method name
     * @param  {Array} [params] Method arguments
     * @return {Promise} resolves to result or error.
     */
    send(method, params) {
        return this._socket.send({
            method,
            params,
        });;
    }


    /**
     * Start an ethereum node.
     * @param  {String} nodeType geth, eth, etc
     * @param  {String} network  network id
     * @return {Promise}
     */
    _start(nodeType, network, syncMode) {
        log.info(`Start node: ${nodeType} ${network} ${syncMode}`);
        const isAlphaNet = (network === 'alpha');

        if (isAlphaNet) {
            log.debug('Node will connect to the alpha network');
        }

        return this.stop()
            .then(() => {
                return this.__startNode(nodeType, network, syncMode)
                    .catch((err) => {
                        log.error('Failed to start node', err);

                        this._showNodeErrorDialog(nodeType, network);

                        throw err;
                    });
            })
            .then((proc) => {
                log.info(`Started node successfully: ${nodeType} ${network} ${syncMode}`);
                this._node = proc;
                this.state = STATES.STARTED;

                Settings.saveUserData('node', this._type);
                Settings.saveUserData('network', this._network);
                Settings.saveUserData('syncmode', this._syncMode);
                return this._socket.connect(Settings.rpcConnectConfig, {
                    timeout: 60000, /* 30s */
                })
                    .then(() => {
                        log.info('STATES.CONNECTED:::',STATES.CONNECTED);
                        this.state = STATES.CONNECTED;
                    })
                    .catch((err) => {
                        log.error('Failed to connect to node', err);

                        if (err.toString().indexOf('timeout') >= 0) {
                            this.emit('nodeConnectionTimeout');
                        }

                        this._showNodeErrorDialog(nodeType, network);

                        throw err;
                    });
            })
            .catch((err) => {
                // set before updating state so that state change event observers
                // can pick up on this
                this.lastError = err.tag;
                this.state = STATES.ERROR;

                // if unable to start eth node then write geth to defaults
                if (nodeType === 'sero') {
                    Settings.saveUserData('node', 'gero');
                }

                throw err;
            });
    }


    /**
     * @return {Promise}
     */
    __startNode(nodeType, network, syncMode) {
        this.state = STATES.STARTING;
        log.info('__startNode(nodeType, network, syncMode)',nodeType, network, syncMode);
        this._network = network;
        this._type = nodeType;
        this._syncMode = syncMode;

        const client = ClientBinaryManager.getClient(nodeType);
        let binPath;
        log.info('client:::',client);
        if (client) {
            binPath = client.binPath;
        } else {
            log.info(`Node "${nodeType}" binPath is not available.`);
            throw new Error(`Node "${nodeType}" binPath is not available.`);
        }

        log.info(`Start node using ${binPath}`);

        return new Q((resolve, reject) => {
            this.__startProcess(nodeType, network, binPath, syncMode)
                .then(resolve, reject);
        });
    }


    /**
     * @return {Promise}
     */
    __startProcess(nodeType, network, binPath, _syncMode) {
        let syncMode = _syncMode;
        if (nodeType === 'gero' && !syncMode) {
            syncMode = 'full';
        }

        return new Q((resolve, reject) => {
            log.trace('Rotate log file');

            // rotate the log file
            logRotate(Settings.constructUserDataPath('node.log'), { count: 5 }, (err) => {
                if (err) {
                    log.error('Log rotation problems', err);

                    return reject(err);
                }

                let args;

                switch (network) {

                // Starts dev network
                case 'dev':
                    args = [
                        '--dev',
                        '--minerthreads', '1',
                        '--ipcpath',Settings.rpcIpcPath
                    ];
                    break;

                // Starts alpha network
                case 'alpha':
                    args = [
                        '--alpha',
                        '--syncmode', syncMode,
                        '--cache', ((process.arch === 'x64') ? '1024' : '512'),
                        '--ipcpath', Settings.rpcIpcPath
                    ];
                    break;

                // Starts beta network
                case 'beta':
                    args = [
                        '--config',  Settings.constructUserDataPath('walletGeroConfig.toml'),
                        '--syncmode', syncMode,
                        '--cache', ((process.arch === 'x64') ? '1024' : '512'),
                        '--ipcpath', Settings.rpcIpcPath
                    ];
                        break;

                    // Starts Main net
                default:
                    args = (nodeType === 'gero')
                        ? [
                            '--syncmode', syncMode,
                            '--cache', ((process.arch === 'x64') ? '1024' : '512')
                        ]
                        : ['--unsafe-transactions'];
                }

                const nodeOptions = Settings.nodeOptions;

                if (nodeOptions && nodeOptions.length) {
                    log.debug('Custom node options', nodeOptions);

                    args = args.concat(nodeOptions);
                }

                var runEnv = {};

                if (binPath.indexOf('gero')>-1){
                    var dylb = binPath.substring(0,binPath.lastIndexOf('gero'))+'geropkg/czero/lib';
                    var dylbwin = binPath.substring(0,binPath.lastIndexOf('gero'))+'geropkg\\czero\\lib';
                    runEnv =  {
                        env: {
                            'DYLD_LIBRARY_PATH': dylb,
                            'LD_LIBRARY_PATH': dylb,
                            'PATH': dylbwin
                        }
                    }
                    log.info('Node runEnv: ',binPath, args,runEnv);

                    log.info('',log.info)
                }

                const proc = spawn(binPath, args,runEnv);
                // const proc = spawn('/Users/huangw/Library/Application Support/Electron/binaries/gero/unpacked/geropkg/bin/gero',['--beta']);


                // node has a problem starting
                proc.once('error', (error) => {
                    log.info(error)
                    if (STATES.STARTING === this.state) {
                        this.state = STATES.ERROR;

                        log.info('Node startup error');

                        // TODO: detect this properly
                        // this.emit('nodeBinaryNotFound');

                        reject(error);
                    }
                });

                log.info(Settings.constructUserDataPath('node.log'));
                // we need to read the buff to prevent node from not working
                proc.stderr.pipe(
                    fs.createWriteStream(Settings.constructUserDataPath('node.log'), { flags: 'a' })
                );

                // when proc outputs data
                proc.stdout.on('data', (data) => {
                    log.trace('Got stdout data');
                    // log.info(data.toString());
                    this.emit('data', data);

                    // check for startup errors
                    if (STATES.STARTING === this.state) {
                        const dataStr = data.toString().toLowerCase();
                        if (nodeType === 'gero') {
                            if (dataStr.indexOf('fatal: error') >= 0) {
                                const error = new Error(`gero error: ${dataStr}`);

                                if (dataStr.indexOf('bind') >= 0) {
                                    error.tag = UNABLE_TO_BIND_PORT_ERROR;
                                }

                                log.debug(error);

                                return reject(error);
                            }
                        }
                    }
                });

                // when proc outputs data in stderr
                proc.stderr.on('data', (data) => {
                    log.trace('Got stderr data');
                    // log.info(data.toString());
                    this.emit('data', data);
                });


                this.on('data', _.bind(this._logNodeData, this));

                // when data is first received
                this.once('data', () => {
                    /*
                        We wait a short while before marking startup as successful
                        because we may want to parse the initial node output for
                        errors, etc (see geth port-binding error above)
                    */
                    setTimeout(() => {
                        if (STATES.STARTING === this.state) {
                            log.info(`${NODE_START_WAIT_MS}ms elapsed, assuming node started up successfully`);

                            resolve(proc);
                        }
                    }, NODE_START_WAIT_MS);
                });
            });
        });
    }


    _showNodeErrorDialog(nodeType, network) {
        let nodelog = this.getLog();

        if (nodelog) {
            nodelog = `...${nodelog.slice(-1000)}`;
        } else {
            nodelog = global.i18n.t('mist.errors.nodeStartup');
        }

        // add node type
        nodelog = `Node type: ${nodeType}\n` +
            `Network: ${network}\n` +
            `Platform: ${process.platform} (Architecture ${process.arch})\n\n${
            nodelog}`;

        dialog.showMessageBox({
            type: 'error',
            buttons: ['OK'],
            message: global.i18n.t('mist.errors.nodeConnect'),
            detail: nodelog,
        }, () => {});
    }


    _logNodeData(data) {
        const cleanData = data.toString().replace(/[\r\n]+/, '');
        const nodeType = (this.type || 'node').toUpperCase();

        log.trace(`${nodeType}: ${cleanData}`);

        if (!/^-*$/.test(cleanData) && !_.isEmpty(cleanData)) {
            this.emit('nodeLog', cleanData);
        }
    }


    _loadDefaults() {
        log.trace('Load defaults');

        this.defaultNodeType = Settings.nodeType || Settings.loadUserData('node') || DEFAULT_NODE_TYPE;
        this.defaultNetwork = Settings.network || Settings.loadUserData('network') || DEFAULT_NETWORK;
        this.defaultSyncMode = Settings.syncmode || Settings.loadUserData('syncmode') || DEFAULT_SYNCMODE;

        log.info(Settings.syncmode, Settings.loadUserData('syncmode'), DEFAULT_SYNCMODE);
        log.info(`Defaults loaded: ${this.defaultNodeType} ${this.defaultNetwork} ${this.defaultSyncMode}`);
    }
}


SeroNode.STARTING = 0;


module.exports = new SeroNode();

import * as fs from 'fs';
import * as os from 'os';
import * as Path from 'path';
import * as crypto from 'crypto';
import * as getStream from 'get-stream';
import * as request from 'request';
import * as requestPromise from 'request-promise';
import * as tar from 'tar';
import { Readable } from 'stream';
import { platform } from 'os';
import * as unzipper from 'unzipper';
import * as cmdShim from 'cmd-shim';
import { promisify } from 'util';
import { Extension } from './version-utils';
import * as stream from 'stream';
import {sync as spawnSync} from 'cross-spawn';
import { __root } from './__root';

export type TODO = any;

/**
 * Fields baked into the package .tar.gz to configure behavior without any code changes.
 */
export interface BuildTags {
    /** npm dist-tag */
    distTag: string;
    /**
     * Powershell version that this package should install,
     * 'latest' if it should install the newest compatible stable version,
     * or 'prerelease' if it should install the newest compatible version including prereleases */
    pwshVersion: string;
}
export const buildTags: BuildTags = require('./buildTags.json');

/** return the sha256 of a file as a hex-formatted string */
export async function sha256OfFile(path: string): Promise<string> {
    const input = fs.createReadStream(path);
    const cipher = crypto.createHash('sha256');
    return (await getStream(input.pipe(cipher), {encoding: 'hex'})).toUpperCase();
}

/** download a URL and save it to a file */
export async function downloadUrlToFile(url: string, path: string, requestOpts?: request.CoreOptions): Promise<any> {
    return new Promise((res, rej) => {
        request.get(url, {
            encoding: null
        }, (err, data) => {
            if(err) {
                return rej(err);
            }

            try {
                fs.writeFileSync(path, data.body);
                res();
            }
            catch(ex) {
                rej(ex);
            }
        });
    });
}
/** download a URL and return it as a string */
export async function downloadUrlAsString(url: string, requestOpts: requestPromise.RequestPromiseOptions): Promise<string> {
    return await requestPromise(url, requestOpts);
}
/** download a URL and return it as parsed JSON */
export async function downloadUrlAsJson<T>(url: string, requestOpts: requestPromise.RequestPromiseOptions): Promise<T> {
    return JSON.parse(await downloadUrlAsString(url, requestOpts));
}

export function readFileWithDefault(path: string, defaultContent: string): string {
    try {
        return fs.readFileSync(path, 'utf8');
    } catch(e) {
        if(!fs.existsSync(path)) return defaultContent;
        throw e;
    }
}

/** Read a JSON file from disk, automatically parsing it, returning default value if the file doesn't exist. */
export function readJsonFileWithDefault(path: string, defaultContent: any): any {
    try {
        return JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch(e) {
        if(!fs.existsSync(path)) return defaultContent;
        throw e;
    }
}

/** Write a JSON file to disk by stringify-ing the value.  Writes UTF-8 encoding. */
export function writeJsonFile(path: string, value: any, indent: boolean | string = true) {
    if(indent === true) indent = '    ';
    fs.writeFileSync(path, JSON.stringify(value, null, indent as string));
}

interface PatchJsonFileOpts { defaultValue: any; indent: string | boolean; }
/**
 * Read JSON from a file, process it with a callback, then write the result back to the file
 * @param callback Returns new value to be stringified.  If it returns undefined, original value is used, which is useful if you modified the original in-place.
 */
export function patchJsonFile(path: string, opts: PatchJsonFileOpts, callback: (v: any) => any);
export function patchJsonFile(path: string, callback: (v: any) => any);
export function patchJsonFile(path: string, _a: any, _b?: any) {
    let [opts = {}, callback] = [_a, _b];
    if(!callback) [opts, callback] = [{}, _a];
    const {defaultValue = null, indent = false} = opts;
    const value = readJsonFileWithDefault(path, defaultValue);
    let newValue = callback(value);
    if(newValue === undefined) newValue = value;
    writeJsonFile(path, newValue, indent);
}

export async function extractArchive(type: Extension, archivePath: string, destination: string) {
    switch(type) {
        case '.tar.gz':
            return extractTarFile(archivePath, destination);
            break;

        case '.zip':
            return extractZipFile(archivePath, destination);
            break;

        default:
            throw new Error('Unsupported archive type: ' + type);
    }
}

/** Extract a tar.gz file into a destination directory. */
export async function extractTarFile(tarPath: string, destination: string) {
    tar.x({
        cwd: destination,
        file: tarPath,
        sync: true
    });
}

/** Extract a zip file into a destination directory. */
export async function extractZipFile(zipPath: string, destination: string) {
    return await finished(fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: destination })));
}

function finished(stream: NodeJS.WritableStream, waitForEvent: 'end' | 'finish' = 'finish') {
    return new Promise((res, rej) => {
        stream.on(waitForEvent, () => {
            res();
        });
        stream.on('error', rej);
    });
}

/** spawn a process on PATH, get the full stdout as a string.  Throw if process returns non-zero status or anything else goes wrong. */
export function getStdout(commandAndArgs): string {
    const result = spawnSync(commandAndArgs[0], commandAndArgs.slice(1), {
        encoding: 'utf8'
    });
    if(result.status !== 0) throw new Error(`process returned non-zero status: ${ result.status }`);
    return result.stdout.trim();
}

/** Returns npm prefix, verbatim (no path normalization, straight from the `npm` command) */
export function getNpmPrefix(): string {
    // TODO memoize this
    return getStdout(['npm', 'config', 'get', 'prefix']);
}

/** get absolute path to the `bin` or `.bin` directory into which npm will install binaries (either symlinks or .cmd stubs) */
export function getNpmBinDirectory() {
    if(isGlobalInstall) {
        switch(process.platform) {
            case 'win32':
                return Path.normalize(getNpmPrefix());
                break;

            case 'linux':
            case 'darwin':
                return Path.resolve(getNpmPrefix(), 'bin');
                break;

            default:
                throw new Error(`Unsupported: global installation on ${ process.platform }`);
        }
    }
    // Local installation: find the local node_modules/.bin
    else {
        if(process.env.npm_lifecycle_event) {
            return Path.resolve(__root, '../.bin');
        } else {
            // This only happens when we're testing
            return Path.resolve(__root, 'test-bin');
        }
    }
}

/**
 * Return absolute, normalized path to the shim that NPM would generate for a package bin script
 */
export function getNpmBinShimPath(name: string) {
    return Path.normalize(Path.join(getNpmBinDirectory(), name + (process.platform === 'win32' ? '.cmd' : '')));
}

/**
 * Return absolute, normalized path to npm's global node_modules directory, where modules are installed globally
 */
export function getNpmGlobalNodeModules() {
    switch(process.platform) {
        case 'win32':
            return Path.resolve(getNpmPrefix(), 'node_modules');
            break;

        case 'linux':
        case 'darwin':
            return Path.resolve(getNpmPrefix(), 'lib', 'node_modules');
            break;

        default:
            throw new Error(`Unsupported: global installation on ${ process.platform }`);
    }
}

/** True if this is an `npm install --global`, false if it's a local install */
export const isGlobalInstall = !!process.env.npm_config_global;

/** Return true if paths point to the same file or directory, taking OS differences into account */
export function pathsEquivalent(path1: string, path2: string): boolean {
    path1 === fullyNormalizePath(path1);
    path2 === fullyNormalizePath(path2);
    return path1 === path2;
}

/** More aggressive path normalization. Convert to lowercase on Windows and strip trailing path separators */
export function fullyNormalizePath(path: string): string {
    path = Path.normalize(path);
    if(process.platform === 'win32') {
        path = path.toLowerCase();
    }
    while(path[path.length - 1] === Path.sep) {
        path = path.slice(0, -1);
    }
    return path;
}

export function unlinkIfExistsSync(path: string) {
    try {
        fs.unlinkSync(path);
    } catch(e) {
        if(e.code !== 'ENOENT') throw e;
    }
}

/**
 * TODO the API and scope of this function is hacky and confusing (e.g. passing a logger instance)
 */
export async function createSymlinkTo(args: {
    linkPath: string;
    targetPath: string;
    intermediateLinkPath: string;
    log: typeof console['log']
}) {
    let {linkPath, targetPath, intermediateLinkPath, log} = args;
    // Resolve all symlinks to avoid problems computing relative paths
    try {
        // For linkPath, we don't actually *need* to resolve it, since we're not dealing with this file. (only target and intermediate paths)
        // Package managers that do funky things may not create the .bin directory we're expecting, so this may fail.
        // Gracefully fallback to the filename sans path.
        // This produces slightly less descriptive output, but at least it's not inaccurate.
        linkPath = fs.realpathSync(linkPath);
    } catch(e) {
        linkPath = Path.basename(linkPath);
    }
    targetPath = fs.realpathSync(targetPath);
    intermediateLinkPath = fs.realpathSync(intermediateLinkPath);
    // unlinkIfExistsSync(linkPath);
    unlinkIfExistsSync(intermediateLinkPath);
    // Windows platforms: use cmd-shim
    if(process.platform === 'win32') {
        log(`Creating .cmd shim from ${ linkPath } to ${ targetPath } (via ${ intermediateLinkPath })...`);
        await promisify(cmdShim)(targetPath, intermediateLinkPath.replace(/\.cmd$/, ''));
    }
    // Non-windows platforms: use a symlink to a symlink
    // Intermediate symlink is necessary because npm refuses to delete .bin/<symlink> unless it points to *within* the module's directory
    else {
        log(`Symlinking from ${ linkPath } to ${ targetPath } (via ${ intermediateLinkPath })...`);
        // fs.symlinkSync(intermediateLinkPath, linkPath);
        fs.symlinkSync(targetPath, intermediateLinkPath);
    }
}

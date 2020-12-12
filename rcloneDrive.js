require('dotenv').config();
const { AutoComplete, Select } = require('enquirer');
const fs = require('fs');
const path = require('path');
const NodeSSH = require('node-ssh');
const cliProgress = require('cli-progress');
let username = process.env.USB_USER;
let host = process.env.USB_HOST;
let password = process.env.USB_PASSWORD;

const bar1 = new cliProgress.SingleBar({
    format: '{bar} {percentage}% | Speed: {speed} {speedUnits} | {currentSize} {currentSizeUnits} / {totalSize} {totalSizeUnits} | ETA: {etaString}'
}, cliProgress.Presets.shades_classic);
let barStarted = false;
const googleDriveRootFolderId = process.env.USB_gdrive_root;
const { google } = require('googleapis');
let creds = require('./private/seedbox-rclone-278014-9362f8e13fdd.json');

let directories = {
    files: 'files',
    movies: 'files/movies',
    shows: 'files/shows'
};

const getGdriveLinkTemplate = (id, isFile) => {
    if (isFile) {
        return `https://drive.google.com/file/d/${id}`
    } else {
        return `https://drive.google.com/drive/folders/${id}`
    }
};

const driveGetAllFolders = async(drive) => {
    let res = await drive.files.list({
        q:`'${googleDriveRootFolderId}' in parents`,
        spaces: 'drive'
    });
    return res.data.files;
};


const client = new google.auth.JWT(
    creds.client_email, null, creds.private_key, ['https://www.googleapis.com/auth/drive']
);

const getRoundedMBytes = (value, units) => {
    let mulFactor;
    switch (units[0]) {
        case "M":
            mulFactor = 1;
            break;
        case "G":
            mulFactor = 1024;
            break;
        default:
            mulFactor = 1;
    }
    return Math.round(value*mulFactor);
};


const main = async() => {

    const directoryInput = new Select({
        name: 'directory',
        message: 'directory to search in',
        choices: Object.keys(directories)
    });
    const directoryKey = await directoryInput.run();
    const targetDirectory = directories[directoryKey];

    const ssh = new NodeSSH();
    await ssh.connect({
        host,
        username,
        password
    });
    // const directoryChangeListCommand = `cd ${directories[directoryKey]} && ls`;
    const directoryResponse = await ssh.execCommand(`ls`, {cwd: targetDirectory});
    const fileDirectoryArray = directoryResponse.stdout.split('\n');

    const fileInput = new AutoComplete({
        name: 'fileName',
        message: 'search for the file/directory',
        limit: 10,
        choices: fileDirectoryArray
    });
    const fileName = await fileInput.run();
    // const isFileCommand = `file "${fileName}"`;
    const isFileResponse = await ssh.execCommand(`file "${fileName}"`, {cwd: targetDirectory});
    const isFile = !isFileResponse.stdout.includes(': directory');


    const rcloneCopyCommand = `rclone copy --progress "${fileName}/" drive:"seedbox/${isFile?"":fileName}"`;
    console.log('>>>Uploading...');

    await ssh.execCommand(rcloneCopyCommand, {
        cwd: targetDirectory,
        onStdout(chunk) {
            const response = chunk.toString("utf8");
            const regexMatchResults = response.match(/Transferred:\s+([\d.]+)([\w]*)\s+\/\s+([\d.]+)\s+([\w]+),\s+(\d{1,3}|-)%?,\s+([\d.]+)\s+([\w/]+),\sETA\s([\w-]+)\n/);
            const [totalMatch, currentSize, currentSizeUnits, totalSize, totalSizeUnits, rclonePercentage, speed, speedUnits, etaString] = regexMatchResults;
            const barPayload = {
                currentSize,
                currentSizeUnits,
                totalSize,
                totalSizeUnits,
                rclonePercentage,
                speed,
                speedUnits,
                etaString,
            };
            const total = getRoundedMBytes(totalSize, totalSizeUnits);
            const value = getRoundedMBytes(currentSize, currentSizeUnits);

            if (!barStarted && parseInt(totalSize)!==0) {
                bar1.start(total, value, barPayload);
                barStarted = true;
            }
            if (barStarted) {
                bar1.update(value, barPayload);
            }
        },
        onStderr(chunk) {
            const response = chunk.toString("utf8");
        },
    });
    bar1.stop();
    console.log('>>>Uploaded!');

    client.authorize((err, tokens) => {
        if (err) {
            throw new Error('google-api authorization failed!')
        } else {
            console.log('>connected to google-apis!!')
        }
    });
    const drive = google.drive({version: 'v3', auth: client});
    let fileList = await driveGetAllFolders(drive);
    let gdriveFileObject = fileList.find((fileObject) => fileObject.name === fileName);
    let gdrivePermissionRespone = await drive.permissions.create({
        fileId: gdriveFileObject.id,
        resource: {
            role: 'reader',
            type: 'anyone'
        },
        fields: 'id'
    });

    await ssh.dispose();
    return getGdriveLinkTemplate(gdriveFileObject.id, isFile);
};

main().then((res)=>{
    console.log(res);
    process.exit();
});


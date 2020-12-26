require('dotenv').config();
const { AutoComplete, Select } = require('enquirer');
const fs = require('fs');
const path = require('path');
const NodeSSH = require('node-ssh');
const cliProgress = require('cli-progress');
const { google } = require('googleapis');

const username = process.env.usbx_username;
const host = process.env.usbx_host;
const password = process.env.usbx_password;
const googleDriveRootFolderId = process.env.usbx_gdriveRootId;
const {client_email, private_key} = require('./private/seedbox-rclone-278014-9362f8e13fdd.json');

const bar1 = new cliProgress.SingleBar({
    format: '{bar} {percentage}% | Speed: {speed} {speedUnits} | {currentSize} {currentSizeUnits} / {totalSize} {totalSizeUnits} | ETA: {etaString}'
}, cliProgress.Presets.shades_classic);

const directories = {
    Downloads: 'Stuff/Local/Downloads',
    movies: 'MergerFS/lw886/movies',
    shows: 'MergerFS/lw886/shows'
};

const client = new google.auth.JWT(
    client_email, null, private_key, ['https://www.googleapis.com/auth/drive']
);

class App {
    barStarted = false;
    shouldCopyToDrive = true;
    targetDirectory = null;
    constructor() {

    }

    getGdriveLinkTemplate = (id, isFile) => {
        if (isFile) {
            return `https://drive.google.com/file/d/${id}`
        } else {
            return `https://drive.google.com/drive/folders/${id}`
        }
    };

    driveGetAllFolders = async(drive) => {
        let res = await drive.files.list({
            q:`'${googleDriveRootFolderId}' in parents`,
            spaces: 'drive'
        });
        return res.data.files;
    };

    getRoundedMBytes = (value, units) => {
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

    getDirFromUser = async () => {
        const directoryInput = new Select({
            name: 'directory',
            message: 'directory to search in',
            choices: Object.keys(directories)
        });
        return await directoryInput.run();
    };

    handleDriveUpload = async (fileName, targetDirectoryKey, isFile, ssh) => {

        const rcloneCopyCommand = `rclone copy --progress "${fileName}/" bmugdrive:"seedbox/${isFile?"":fileName}"`;
        console.log('[INFO]Started Uploading');

        await ssh.execCommand(rcloneCopyCommand, {
            cwd: `Stuff/Local/${targetDirectoryKey==="Downloads"?"Downloads":`lw886/${targetDirectoryKey}`}`,
            onStdout: (chunk) => {
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
                const total = this.getRoundedMBytes(totalSize, totalSizeUnits);
                const value = this.getRoundedMBytes(currentSize, currentSizeUnits);

                if (!this.barStarted && parseInt(totalSize)!==0) {
                    bar1.start(total, value, barPayload);
                    this.barStarted = true;
                }
                if (this.barStarted) {
                    bar1.update(value, barPayload);
                }
            },
            onStderr(chunk) {
                const response = chunk.toString("utf8");
                console.log(response);
            },
        });
        bar1.stop();
        console.log('[INFO]Finished Uploading');

        client.authorize((err, tokens) => {
            if (err) {
                throw new Error('[INFO]google-api authorization failed')
            } else {
                console.log('[INFO]connected to google-apis!!')
            }
        });
        const drive = google.drive({version: 'v3', auth: client});
        let fileList = await this.driveGetAllFolders(drive);
        let gdriveFileObject = fileList.find((fileObject) => fileObject.name === fileName);
        let gdrivePermissionRespone = await drive.permissions.create({
            fileId: gdriveFileObject.id,
            resource: {
                role: 'reader',
                type: 'anyone'
            },
            fields: 'id'
        });
        console.log("[INFO]File Permissions chnaged")
        await ssh.dispose();
        return this.getGdriveLinkTemplate(gdriveFileObject.id, isFile);
    };

    init = async () => {
        const targetDirectoryKey = await this.getDirFromUser();
        this.targetDirectory = directories[targetDirectoryKey];

        const ssh = new NodeSSH();
        await ssh.connect({
            host,
            username,
            password
        });

        const listDirResponse = await ssh.execCommand(`ls`, {cwd: this.targetDirectory});
        const fileInput = new AutoComplete({
            name: 'fileName',
            message: 'search for the file/directory',
            limit: 10,
            choices: listDirResponse.stdout.split('\n')
        });
        const fileName = await fileInput.run();

        const isFileResponse = await ssh.execCommand(`file "${fileName}"`, {cwd: this.targetDirectory});
        const isFile = !isFileResponse.stdout.includes(': directory');

        //IF THE FOLDER IS NOT DOWNLOADS, CHECK IF THE MOVIE/SHOW IS ALREADY ON GDRIVE
        const testResponse = await ssh.execCommand(`test -e "${fileName}" echo 1 || echo 0`,
            {cwd: `~/Stuff/Local/lw886/${targetDirectoryKey}`});
        if (targetDirectoryKey !== "Downloads" && parseInt(testResponse.stdout) === 1) {
            const rcloneListDirResponse = await ssh.execCommand(`rclone lsjson bmugdrive:lw886/${targetDirectoryKey}`);
            const rcloneFileObjects = JSON.parse(rcloneListDirResponse.stdout.replace("\n", ""));
            const fileObject = rcloneFileObjects.find(obj => obj.name === fileName)
            return this.getGdriveLinkTemplate(fileObject.ID, isFile);
        } else {
            return await this.handleDriveUpload(fileName, targetDirectoryKey, isFile, ssh);
        }
    };
}


const main = async() => {
    const app = new App();
    const resultDriveLink = await app.init();
    console.log(resultDriveLink);
};

main().catch(err=>console.log(err));


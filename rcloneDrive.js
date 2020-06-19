const { AutoComplete, Select } = require('enquirer');
const fs = require('fs');
const path = require('path');
const NodeSSH = require('node-ssh');

let username = process.env.USB_USER;
let host = process.env.USB_HOST;
let password = process.env.USB_PASSWORD;

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


const main = async() => {

    const directoryInput = new Select({
        name: 'directory',
        message: 'directory to search in',
        choices: Object.keys(directories)
    });
    let directoryKey = await directoryInput.run();

    let ssh = new NodeSSH();
    await ssh.connect({
        host,
        username,
        password
    });
    let directoryChangeListCommand = `cd ${directories[directoryKey]} && ls`;
    let directoryResponse = await ssh.execCommand(directoryChangeListCommand);
    let fileDirectoryArray = directoryResponse.stdout.split('\n');

    const fileInput = new AutoComplete({
        name: 'fileName',
        message: 'search for the file/directory',
        limit: 10,
        choices: fileDirectoryArray
    });
    let fileName = await fileInput.run();
    let isFileCommand = `cd ${directories[directoryKey]} && file "${fileName}"`;
    let isFileResponse = await ssh.execCommand(isFileCommand);
    let isFile = !isFileResponse.stdout.includes(': directory');


    let rcloneCopyCommand = isFile?`cd ${directories[directoryKey]} && rclone copy "${fileName}/" drive:"seedbox/"`:`cd ${directories[directoryKey]} && rclone copy "${fileName}/" drive:"seedbox/${fileName}"`;
    console.log('>>>Uploading...');
    let rcloneResponse = await ssh.execCommand(rcloneCopyCommand);
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


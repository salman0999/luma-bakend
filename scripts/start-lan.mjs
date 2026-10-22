import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['dist/server.js'],{stdio:'inherit',env:{...process.env,LUMA_HOST:process.env.LUMA_HOST||'0.0.0.0'}});
child.on('exit',code=>process.exitCode=code||0);

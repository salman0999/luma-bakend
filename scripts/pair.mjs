import {readFile} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import path from 'node:path';
const dir=path.resolve(process.env.LUMA_DATA_DIR||'data');
let token=process.env.LUMA_API_TOKEN;
if(!token){try{token=(await readFile(path.join(dir,'auth-token'),'utf8')).trim();}catch{console.error('Start the backend once before pairing.');process.exit(1);}}
console.log('Luma Android → Add media → Providers → Connect backend');
for(const group of Object.values(networkInterfaces()))for(const item of group||[])if(item.family==='IPv4'&&!item.internal)console.log(`Backend URL: http://${item.address}:${process.env.LUMA_PORT||4317}`);
console.log('API token (keep private): '+token);
console.log('Use the same Wi-Fi network. Run npm run start:lan for phone access.');

import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {ProviderService,sourceSpec} from './core.js';

export async function restoreProviders(service:ProviderService,repository:string|undefined,selection:string|undefined){
 const values=[...new Set((selection||'').split(',').map(value=>value.trim()).filter(Boolean))];
 if(!values.length)return;
 if(!repository||values.length>6||values.some(value=>!/^[A-Za-z0-9_-]{1,80}$/.test(value)))throw new Error('Configure a provider repository and up to six valid provider IDs.');
 const spec=sourceSpec(repository);
 let source=service.state.sources.find(s=>s.owner.toLowerCase()===spec.owner.toLowerCase()&&s.repo.toLowerCase()===spec.repo.toLowerCase()&&s.ref===spec.ref);
 if(!source)source=await service.addSource(repository);
 for(const value of values){const existing=service.state.plugins.find(p=>p.id===source.id+'.'+value);if(!existing)await service.install(source.id,value);}
}
export async function bootstrap(){
 const service=new ProviderService(path.resolve(process.env.LUMA_DATA_DIR||'data'));await service.init();
 await restoreProviders(service,process.env.LUMA_BOOTSTRAP_REPOSITORY,process.env.LUMA_BOOTSTRAP_PROVIDERS);
 console.log('Configured providers are ready.');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)bootstrap().catch(error=>{console.error(error instanceof Error?error.message:'Provider restore failed.');process.exitCode=1;});

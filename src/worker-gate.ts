export class WorkerGate {
 private active=0;private waiting:{resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}[]=[];
 constructor(readonly limit=6,private timeout=10000){}
 async acquire(){
  if(this.active<this.limit){this.active++;return;}
  if(this.waiting.length>=12)throw new Error('The backend is busy. Try again in a moment.');
  await new Promise<void>((resolve,reject)=>{const item={resolve,reject,timer:setTimeout(()=>{const index=this.waiting.indexOf(item);if(index>=0)this.waiting.splice(index,1);reject(new Error('The backend is busy. Try again in a moment.'));},this.timeout)};this.waiting.push(item);});
 }
 release(){const next=this.waiting.shift();if(next){clearTimeout(next.timer);next.resolve();}else this.active=Math.max(0,this.active-1);}
}
export function workerLimit(value:string|undefined){if(value===undefined)return 6;const limit=Number(value);if(!Number.isInteger(limit)||limit<1||limit>6)throw new Error('LUMA_MAX_WORKERS must be an integer from 1 to 6.');return limit;}

import { getBff } from '@/lib/runtime';
import { webThemeFrom } from '@/lib/web-themes';
/** Theme the first-party auth landing pages; credentials and verification remain owned by the IdP. */
export async function ExplorerAuthTheme({children}:{children:React.ReactNode}) {
 const theme=webThemeFrom(await getBff().loadWebTheme().catch(()=>null));
 return theme==='explorer'?<div className="t-explorer atlas-auth">{children}</div>:<>{children}</>;
}

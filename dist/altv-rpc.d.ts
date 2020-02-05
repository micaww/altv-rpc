export as namespace rpc;

export function init(namespace: string): void;
export function addWebView(webView: any): void;
export function register(name: string, cb: ProcedureListener): void;
export function unregister(name: string): void;
export function call<T = any>(name: string, args?: any, options?: CallOptions): Promise<T>;
export function callServer<T = any>(name: string, args?: any, options?: CallOptions): Promise<T>;
export function callClient<T = any>(player: any, name: string, args?: any, options?: CallOptions): Promise<T>;
export function callClient<T = any>(name: string, args?: any, options?: CallOptions): Promise<T>;
export function callBrowsers<T = any>(player: any, name: string, args?: any, options?: CallOptions): Promise<T>;
export function callBrowsers<T = any>(name: string, args?: any, options?: CallOptions): Promise<T>;
export function callBrowser<T = any>(browser: any, name: string, args?: any, options?: CallOptions): Promise<T>;

export function on(name: string, cb: ProcedureListener): void;
export function off(name: string, cb: ProcedureListener): void;
export function trigger(name: string, args?: any): void;
export function triggerServer(name: string, args?: any): void;
export function triggerClient(player: any, name: string, args?: any): void;
export function triggerClient(name: string, args?: any): void;
export function triggerBrowsers(player: any, name: string, args?: any): void;
export function triggerBrowsers(name: string, args?: any): void;
export function triggerBrowser(browser: any, name: string, args?: any): void;

export interface ProcedureListenerInfo {
    environment: string;
    id?: string;
    player?: any;
}

export interface CallOptions {
    timeout?: number;
    noRet?: boolean;
}

export type ProcedureListener = (args: any, info: ProcedureListenerInfo) => any;
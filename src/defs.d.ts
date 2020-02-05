declare type ProcedureListener = (args: any, info: ProcedureListenerInfo) => any;

declare module 'alt' {
    const x: any;

    export default x;
}

declare interface ProcedureListenerInfo {
    environment: string;
    id?: string;
    player?: any;
    browser?: any;
}

declare interface CallOptions {
    timeout?: number;
    noRet?: boolean;
}

declare interface Event {
    req?: number;
    ret?: number;
    id: string;
    name?: string;
    args?: any;
    env: string;
    fenv?: string;
    res?: any;
    err?: any;
    noRet?: number;
}
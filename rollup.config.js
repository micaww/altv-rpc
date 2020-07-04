import resolve from '@rollup/plugin-node-resolve';
import modify from 'rollup-plugin-modify';
import babel from 'rollup-plugin-babel';
import minify from 'rollup-plugin-babel-minify';
import replace from '@rollup/plugin-replace';

const ENVIRONMENT = process.env.NODE_ENV;

export default [
    {
        input: './src/index.ts',
        output: {
            file: './dist/altv-rpc.mjs',
            format: 'esm'
        },
        plugins: [
            replace({
                'process.env.NODE_ENV': JSON.stringify(ENVIRONMENT || 'development')
            }),
            resolve({
                extensions: ['.ts']
            }),
            babel({
                extensions: ['.ts']
            }),
            ENVIRONMENT === 'production' ? minify({
                comments: false
            }) : undefined
        ],
        external: ['alt']
    },
    {
        input: './src/index.ts',
        output: {
            file: './dist/altv-rpc-browser.js',
            format: 'umd',
            name: 'rpc'
        },
        plugins: [
            replace({
                'process.env.NODE_ENV': JSON.stringify(ENVIRONMENT || 'development')
            }),
            modify({
                find: /import alt from 'alt';/,
                replace: ''
            }),
            resolve({
                extensions: ['.ts']
            }),
            babel({
                extensions: ['.ts']
            }),
            ENVIRONMENT === 'production' ? minify({
                comments: false
            }) : undefined
        ],
        external: ['alt']
    }
];
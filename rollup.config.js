import resolve from '@rollup/plugin-node-resolve';
import babel from 'rollup-plugin-babel';
import minify from 'rollup-plugin-babel-minify';

export default {
    input: './src/index.ts',
    output: {
        file: './dist/altv-rpc.mjs',
        format: 'esm'
    },
    plugins: [
        resolve({
            extensions: ['.ts']
        }),
        babel({
            extensions: ['.ts']
        }),
        process.env.BUILD === 'production' ? minify({
            comments: false
        }) : undefined
    ],
    external: ['alt']
}
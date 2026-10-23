import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({base:'./',plugins:[react()],server:{port:5178,strictPort:true,watch:{ignored:['**/output/**','**/research/raw/**','**/release/**']}},build:{outDir:'dist'}});

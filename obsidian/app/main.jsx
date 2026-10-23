import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.jsx';
import './style.css';
class Boundary extends React.Component{state={error:null};static getDerivedStateFromError(error){return{error};}render(){return this.state.error?<div className="fatal"><h1>应用遇到了问题</h1><p>{String(this.state.error.message)}</p><button onClick={()=>location.reload()}>重新载入</button><p>已保存的本地笔记仍在原文件夹。</p></div>:this.props.children;}}
createRoot(document.getElementById('root')).render(<Boundary><App/></Boundary>);

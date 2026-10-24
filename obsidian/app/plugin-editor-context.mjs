import {Facet, StateField} from '@codemirror/state';
export const pluginEditorContext = Facet.define({combine: values => values.at(-1) || {file: null, livePreview: false}});
export const editorInfoField = StateField.define({create: state => ({file: state.facet(pluginEditorContext).file}), update: (_value, tr) => ({file: tr.state.facet(pluginEditorContext).file})});
export const editorLivePreviewField = StateField.define({create: state => state.facet(pluginEditorContext).livePreview, update: (_value, tr) => tr.state.facet(pluginEditorContext).livePreview});

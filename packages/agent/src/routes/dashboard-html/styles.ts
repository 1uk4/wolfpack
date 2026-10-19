export const STYLES_CSS = `<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; margin: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
       background: #0f1115; color: #e6e6e6; height: 100vh; width: 100vw;
       overflow: hidden; position: relative;
       -webkit-tap-highlight-color: rgba(126, 183, 255, 0.25); }
/* Kill the 300ms double-tap-zoom delay on everything tappable. */
.btn, .fab, select, #breadcrumb, #breadcrumb .crumb-row,
#tree .tree-section, #tree .tree-entry,
#panel-children .pc-row, #panel-parent,
#modal-close { touch-action: manipulation; }

/* Floating top navigation — dropdown + breadcrumb pill, centered. */
#topnav { position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
          z-index: 100; display: flex; flex-direction: column; align-items: center;
          gap: 8px; max-width: calc(100vw - 160px); pointer-events: none; }
#topnav > * { pointer-events: auto; }
#topnav select { background: #161922; color: #e6e6e6; border: 1px solid #2d3340;
                 border-radius: 20px; padding: 8px 14px; font-size: 13px;
                 min-width: 220px; box-shadow: 0 4px 14px rgba(0,0,0,0.4); }
#breadcrumb { background: #161922e6; backdrop-filter: blur(8px);
              border: 1px solid #2d3340; border-radius: 14px;
              padding: 6px 10px; font-size: 12px; color: #cdd6e4;
              max-width: min(380px, calc(100vw - 180px));
              display: none; cursor: pointer;
              box-shadow: 0 4px 14px rgba(0,0,0,0.4); }
#breadcrumb.active { display: block; }
#breadcrumb .crumb-row { display: flex; align-items: center; gap: 4px;
                         padding: 2px 4px; border-radius: 6px;
                         min-height: 20px; white-space: nowrap;
                         overflow: hidden; }
#breadcrumb .crumb-row:hover { background: #1d2230; }
#breadcrumb .crumb-label { overflow: hidden; text-overflow: ellipsis; }
#breadcrumb .crumb-row.is-tail .crumb-label { color: #f7768e; font-weight: 600; }
#breadcrumb .crumb-row:not(.is-tail) .crumb-label { color: #cdd6e4; }
#breadcrumb .crumb-arrow { color: #3d4553; width: 12px; flex-shrink: 0;
                           font-family: ui-monospace, Menlo, monospace;
                           font-size: 11px; }
#breadcrumb .crumb-depth { display: inline-block; flex-shrink: 0; }
#breadcrumb .crumb-toggle { color: #8b94a3; margin-left: auto; font-size: 10px;
                            padding: 0 4px; flex-shrink: 0; }
/* When collapsed, hide every row except the top one (depth 0). */
#breadcrumb:not(.open) .crumb-row:not([data-depth="0"]) { display: none; }
#breadcrumb.open .crumb-toggle { transform: rotate(180deg); }

/* Floating action buttons. The invisible padding box expands the hit target
   beyond the visible circle so edge taps still register on mobile. */
.fab { position: fixed; top: 4px; z-index: 100;
       background: #161922; color: #cdd6e4; border: 1px solid #2d3340;
       border-radius: 50%; width: 44px; height: 44px; font-size: 20px;
       line-height: 1; cursor: pointer; padding: 0;
       box-shadow: 0 4px 14px rgba(0,0,0,0.4);
       transition: background 0.15s, color 0.15s;
       display: flex; align-items: center; justify-content: center;
       margin: 8px;                /* invisible hit padding */
       background-clip: padding-box; }
.fab:hover { background: #1d2230; }
.fab.active { background: #2d3b55; color: #9ecbff; border-color: #3b4e74; }
.fab.fab-left { left: 12px; }
.fab.fab-right { right: 12px; }

/* View-mode segmented toggle — sits inside the graph viewport, top-left,
   next to the file-viewer FAB. Flips the dashboard between KB and Work views. */
#mode-toggle { position: fixed; top: 20px; left: 72px; z-index: 100;
               display: inline-flex; gap: 2px;
               background: #161922e6; backdrop-filter: blur(8px);
               border: 1px solid #2d3340; border-radius: 20px; padding: 3px;
               box-shadow: 0 4px 14px rgba(0,0,0,0.4); }
#mode-toggle button { background: transparent; color: #8b94a3; border: none;
                      padding: 5px 14px; font-size: 12px; cursor: pointer;
                      border-radius: 16px; font-weight: 500;
                      touch-action: manipulation; }
#mode-toggle button:hover { color: #cdd6e4; }
#mode-toggle button.active { background: #2d3b55; color: #9ecbff; }

/* Main layout fills the entire viewport; tree/panel float on top. */
#main { position: absolute; inset: 0; }
#tree { position: absolute; top: 0; left: 0; bottom: 0;
        width: 320px; background: #12151cf0; backdrop-filter: blur(8px);
        border-right: 1px solid #262b36;
        overflow-y: auto; padding: 72px 14px 20px; font-size: 12px;
        display: none; z-index: 50; }
#tree.open { display: block; }
#tree .tree-domain { font-weight: 600; color: #9ecbff; margin-bottom: 8px; font-size: 13px; }
#tree .tree-section { cursor: pointer; padding: 4px 6px; border-radius: 4px;
                      border-left: 3px solid #7bdff2; margin: 2px 0; }
#tree .tree-section:hover { background: #1d2230; }
#tree .tree-section.on-route { background: #2a1c22; border-left-color: #f7768e; }
#tree .tree-section.on-route .label { color: #f7768e; }
#tree .tree-entry.on-route { background: #2a1c22; color: #f7768e; font-weight: 600; }
#tree .tree-entry.selected,
#tree .tree-section.selected { outline: 1px solid #f7768e; }
#tree .tree-section .arrow { display: inline-block; width: 12px; font-size: 10px;
                              color: #7bdff2; transition: transform 0.15s; }
#tree .tree-section .arrow.open { transform: rotate(90deg); }
#tree .tree-section .label { color: #cdd6e4; }
#tree .tree-section .count { color: #8b94a3; font-size: 11px; margin-left: 4px; }
#tree .tree-children { margin-left: 12px; display: none; }
#tree .tree-children.open { display: block; }
#tree .tree-entry { padding: 2px 6px; color: #8b94a3; cursor: pointer; border-radius: 3px; }
#tree .tree-entry:hover { background: #1d2230; color: #cdd6e4; }
/* Done tasks (shipped/live/archived) read as muted green in the tree. */
#tree .tree-entry.done { color: #73c99a; opacity: 0.75; }
#tree .tree-section.done > .label { color: #73c99a; opacity: 0.85; }
#graph { position: absolute; inset: 0; background: #0f1115; }

/* Side panel (reader) */
#panel { position: absolute; top: 0; right: 0; bottom: 0;
         width: 500px; max-width: 90vw; border-left: 1px solid #262b36;
         background: #12151cf0; backdrop-filter: blur(8px);
         overflow-y: auto; padding: 72px 22px 20px; display: none; z-index: 50; }
#panel.open { display: block; }
#panel .placeholder { color: #5c6573; font-size: 13px; margin-top: 40px; text-align: center; }
#panel-title { font-size: 16px; font-weight: 600; color: #9ecbff; margin-bottom: 8px; }
#panel-meta { font-size: 12px; color: #8b94a3; margin-bottom: 14px; line-height: 1.7; }
#panel-meta .tag { display: inline-block; background: #1d2230; border: 1px solid #2d3340;
                   border-radius: 4px; padding: 1px 7px; margin: 2px 4px 2px 0; color: #b9c2d0; }
#panel-body { line-height: 1.6; font-size: 14px; }
#panel-parent { display: none; align-items: center; gap: 6px;
                margin-bottom: 10px; padding: 6px 10px;
                background: #161922; border: 1px solid #262b36;
                border-radius: 8px; cursor: pointer; font-size: 12px;
                color: #8b94a3; max-width: fit-content;
                transition: background 0.12s, color 0.12s, border-color 0.12s; }
#panel-parent.active { display: inline-flex; }
#panel-parent:hover { background: #1d2230; color: #cdd6e4; border-color: #3b4256; }
#panel-parent .pp-arrow { color: #f7768e; font-family: ui-monospace, Menlo, monospace; }
#panel-parent .pp-label { overflow: hidden; text-overflow: ellipsis;
                          white-space: nowrap; max-width: 260px; }

#panel-children { margin: 10px 0 18px; display: none; }
#panel-children.active { display: block; }
#panel-children .pc-header { font-size: 11px; text-transform: uppercase;
                             letter-spacing: 0.08em; color: #5c6573;
                             margin-bottom: 6px; }
#panel-children .pc-row { display: flex; align-items: center; gap: 6px;
                          padding: 6px 10px; margin: 3px 0;
                          background: #161922; border: 1px solid #262b36;
                          border-radius: 8px; cursor: pointer; font-size: 13px;
                          color: #cdd6e4; transition: background 0.12s, border-color 0.12s; }
#panel-children .pc-row:hover { background: #1d2230; border-color: #3b4256; }
#panel-children .pc-row .pc-icon { font-size: 10px; color: #7bdff2; width: 12px;
                                    flex-shrink: 0; }
#panel-children .pc-row.pc-entry .pc-icon { color: #9ece6a; }
#panel-children .pc-row .pc-label { overflow: hidden; text-overflow: ellipsis;
                                    white-space: nowrap; flex: 1; }
#panel-children .pc-row .pc-count { color: #5c6573; font-size: 11px; flex-shrink: 0; }
#panel-body h1 { font-size: 20px; border-bottom: 1px solid #262b36; padding-bottom: 6px; }
#panel-body h2 { font-size: 16px; color: #9ecbff; margin-top: 22px; }
#panel-body h3 { font-size: 14px; color: #c9d4e3; }
#panel-body code { background: #1d2230; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
#panel-body pre { background: #1a1e27; padding: 12px; border-radius: 8px; overflow-x: auto; }
#panel-body pre code { background: none; padding: 0; }
#panel-body a { color: #9ecbff; }
#panel-body table { border-collapse: collapse; width: 100%; margin: 8px 0; }
#panel-body td, #panel-body th { border: 1px solid #2d3340; padding: 4px 8px; font-size: 12px; }

/* Modal */
#modal-overlay { display: none; position: fixed; inset: 0;
                 background: rgba(0,0,0,0.7); z-index: 1000; align-items: center; justify-content: center; }
#modal-overlay.open { display: flex; }
#modal { background: #12151c; border: 1px solid #2d3340; border-radius: 12px;
         width: 90%; max-width: 700px; max-height: 85vh; display: flex; flex-direction: column; }
#modal-header { display: flex; align-items: center; justify-content: space-between;
                padding: 14px 18px; border-bottom: 1px solid #262b36; }
#modal-title { font-size: 16px; font-weight: 600; color: #9ecbff; }
#modal-close { background: none; border: none; color: #8b94a3; font-size: 20px; cursor: pointer; }
#modal-close:hover { color: #e6e6e6; }
#modal-body { flex: 1; overflow-y: auto; padding: 18px 22px; line-height: 1.6; font-size: 14px; }
#modal-body h1 { font-size: 20px; border-bottom: 1px solid #262b36; padding-bottom: 6px; }
#modal-body h2 { font-size: 16px; color: #9ecbff; margin-top: 22px; }
#modal-body code { background: #1d2230; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
#modal-body pre { background: #1a1e27; padding: 12px; border-radius: 8px; overflow-x: auto; }
#modal-body pre code { background: none; padding: 0; }
#modal-body a { color: #9ecbff; }

/* ─── Mobile: tree + panel become fullscreen; FABs stay accessible ───── */
@media (max-width: 768px) {
  #topnav { top: 10px; max-width: calc(100vw - 120px); }
  #topnav select { min-width: 180px; min-height: 40px; font-size: 14px; }
  .fab { width: 48px; height: 48px; font-size: 22px; margin: 6px; }
  #mode-toggle { top: 16px; left: 68px; }
  #mode-toggle button { padding: 7px 12px; font-size: 13px; }

  /* Backdrop blur is expensive on mobile GPUs — use solid backgrounds. */
  #breadcrumb, #tree, #panel { backdrop-filter: none; }
  #breadcrumb { background: #161922; }
  #tree, #panel { background: #12151c; }

  #tree, #panel {
    width: 100vw; max-width: none;
    border: none; padding: 110px 16px 20px;
  }
  body.has-overlay #graph { visibility: hidden; }
  #panel-body { font-size: 15px; line-height: 1.65; }
  #panel-body pre { font-size: 12px; }

  /* Larger tap zones for in-overlay rows. */
  #tree .tree-section, #tree .tree-entry { padding: 10px 8px; font-size: 14px; }
  #tree .tree-children { margin-left: 14px; }
  #breadcrumb .crumb-row { min-height: 30px; padding: 6px 8px; font-size: 13px; }
  #panel-children .pc-row { padding: 10px 12px; font-size: 14px; }
  #panel-parent { padding: 10px 12px; font-size: 13px; }

  /* Modal: fullscreen on narrow */
  #modal { width: 100%; max-width: none; height: 100vh; max-height: 100vh;
           border-radius: 0; border: none; }
  #modal-header { padding: 12px 14px; }
  #modal-title { font-size: 15px; padding-right: 40px; }
  #modal-close { font-size: 28px; min-width: 36px; min-height: 36px; }
  #modal-body { padding: 14px 16px; font-size: 15px; line-height: 1.65; }
  #modal-body pre { font-size: 12px; }
}
</style>
`;

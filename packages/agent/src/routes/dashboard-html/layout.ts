export const LAYOUT_HTML = `</head>
<body>

<div id="topnav">
  <select id="domainSelect" aria-label="Domain"></select>
  <div id="breadcrumb" title="Route to selected node"></div>
</div>

<button id="fileToggle" class="fab fab-left" aria-label="File viewer" title="File viewer (route)">☰</button>
<button id="readerToggle" class="fab fab-right" aria-label="Reader" title="Reader (selected node)">☰</button>

<div id="mode-toggle" role="radiogroup" aria-label="View mode">
  <button type="button" data-mode="kb" aria-pressed="true">KB</button>
  <button type="button" data-mode="work" aria-pressed="false">Work</button>
</div>

<div id="main">
  <div id="tree"></div>
  <div id="graph"></div>
  <div id="panel">
    <div class="placeholder">Select a node to view it.</div>
    <div id="panel-parent" title="Up one level"></div>
    <div id="panel-title" style="display:none"></div>
    <div id="panel-meta" style="display:none"></div>
    <div id="panel-children"></div>
    <div id="panel-body" style="display:none"></div>
  </div>
</div>

<div id="modal-overlay">
  <div id="modal">
    <div id="modal-header">
      <span id="modal-title"></span>
      <button id="modal-close">&times;</button>
    </div>
    <div id="modal-body"></div>
  </div>
</div>

<script>
`;

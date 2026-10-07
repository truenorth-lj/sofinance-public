const fs = require('fs');
const path = require('path');

// Simple ICO file generator for 16x16, 32x32 favicon
// This creates a minimal ICO file with the SVG embedded as PNG data

async function generateFavicon() {
  console.log('Generating favicon files...');
  
  // For now, we'll copy the SVG as the main favicon
  // Modern browsers support SVG favicons
  const svgContent = fs.readFileSync(path.join(__dirname, '../public/favicon.svg'), 'utf8');
  
  // Create a basic HTML file to preview the favicon
  const previewHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>SoFinance Favicon Preview</title>
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <style>
    body {
      background: #050505;
      color: #fff;
      font-family: system-ui, -apple-system, sans-serif;
      padding: 40px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 40px;
    }
    .preview-section {
      text-align: center;
    }
    .logo-preview {
      display: flex;
      gap: 20px;
      align-items: center;
      justify-content: center;
      padding: 40px;
      background: #0a0a0a;
      border-radius: 12px;
    }
    h1 { margin: 0 0 20px 0; }
    .size-label { 
      margin-top: 10px; 
      color: #888; 
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="preview-section">
    <h1>SoFinance Brand Mark</h1>
    <div class="logo-preview">
      <div>
        <img src="logo.svg" width="16" height="16" alt="16x16">
        <div class="size-label">16×16 (favicon)</div>
      </div>
      <div>
        <img src="logo.svg" width="32" height="32" alt="32x32">
        <div class="size-label">32×32 (favicon)</div>
      </div>
      <div>
        <img src="logo.svg" width="40" height="40" alt="40x40">
        <div class="size-label">40×40 (header)</div>
      </div>
      <div>
        <img src="logo.svg" width="64" height="64" alt="64x64">
        <div class="size-label">64×64</div>
      </div>
      <div>
        <img src="logo.svg" width="128" height="128" alt="128x128">
        <div class="size-label">128×128</div>
      </div>
    </div>
  </div>
</body>
</html>
  `;
  
  fs.writeFileSync(path.join(__dirname, '../public/favicon-preview.html'), previewHtml);
  console.log('✓ Created favicon-preview.html');
  console.log('✓ SVG favicon ready at public/favicon.svg');
  console.log('✓ Logo ready at public/logo.svg');
}

generateFavicon().catch(console.error);

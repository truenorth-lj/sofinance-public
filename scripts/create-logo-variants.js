const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function createLogoVariants() {
  console.log('Creating SoFinance logo variants from OpenIntern avatar...');
  
  const avatarPath = path.join(__dirname, '../public/avatar-full.png');
  const publicDir = path.join(__dirname, '../public');
  
  try {
    // Read the original avatar
    const avatar = sharp(avatarPath);
    const metadata = await avatar.metadata();
    console.log(`Original avatar: ${metadata.width}x${metadata.height}`);
    
    // Create circular cropped version for header (40x40)
    // Focus on the face/head area (upper portion of the image)
    const cropSize = 900; // Crop a square from the top-center
    const cropTop = 0;
    const cropLeft = Math.floor((metadata.width - cropSize) / 2);
    
    await avatar
      .extract({ left: cropLeft, top: cropTop, width: cropSize, height: cropSize })
      .resize(40, 40, { fit: 'cover' })
      .png()
      .toFile(path.join(publicDir, 'logo.png'));
    console.log('✓ Created logo.png (40x40 header)');
    
    // Create larger version for apple-touch-icon (180x180)
    await sharp(avatarPath)
      .extract({ left: cropLeft, top: cropTop, width: cropSize, height: cropSize })
      .resize(180, 180, { fit: 'cover' })
      .png()
      .toFile(path.join(publicDir, 'apple-touch-icon.png'));
    console.log('✓ Created apple-touch-icon.png (180x180)');
    
    // Create medium favicon sizes (32x32, 16x16)
    await sharp(avatarPath)
      .extract({ left: cropLeft, top: cropTop, width: cropSize, height: cropSize })
      .resize(32, 32, { fit: 'cover' })
      .png()
      .toFile(path.join(publicDir, 'favicon-32.png'));
    console.log('✓ Created favicon-32.png');
    
    await sharp(avatarPath)
      .extract({ left: cropLeft, top: cropTop, width: cropSize, height: cropSize })
      .resize(16, 16, { fit: 'cover' })
      .png()
      .toFile(path.join(publicDir, 'favicon-16.png'));
    console.log('✓ Created favicon-16.png');
    
    // Create a simple SVG wrapper (just references the PNG)
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 40 40" width="40" height="40">
  <image href="/logo.png" x="0" y="0" width="40" height="40" />
</svg>`;
    
    fs.writeFileSync(path.join(publicDir, 'logo.svg'), svgContent);
    console.log('✓ Created logo.svg wrapper');
    
    console.log('\n✅ All logo variants created successfully!');
    
  } catch (error) {
    console.error('Error creating logo variants:', error);
    process.exit(1);
  }
}

createLogoVariants();

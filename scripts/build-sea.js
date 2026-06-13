/**
 * Node.js SEA (Single Executable Application) 构建脚本
 * 
 * 使用方法:
 *   1. 确保 Node.js >= 20.11.0
 *   2. npm run build:sea
 * 
 * 这会将整个项目打包成单个可执行文件。
 * 注意事项：
 *   - 生成的可执行文件会在运行时自动解压 config.yaml、certs/ 等资源
 *   - 首次运行会自动生成 CA 证书
 *   - 日志文件 proxy.log 会在运行目录创建
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  console.log('=== ModelProxy SEA 构建 ===\n');

  // 检查 Node.js 版本
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0]);
  if (major < 20) {
    console.error(`❌ 需要 Node.js >= 20.11.0，当前版本: ${nodeVersion}`);
    console.error('   请升级 Node.js: https://nodejs.org/');
    process.exit(1);
  }
  console.log(`✅ Node.js 版本: ${nodeVersion}`);

  // 1. 生成一个 blob 包含所有需要的资源
  console.log('\n1️⃣  生成资源清单...');

  // 需要打包进可执行文件的额外资源
  const assets = {
    'config.yaml': fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf-8'),
  };

  // 如果 certs 目录存在，也打包进去
  const certsDir = path.join(ROOT, 'certs');
  if (fs.existsSync(certsDir)) {
    const certFiles = fs.readdirSync(certsDir);
    for (const file of certFiles) {
      const filePath = path.join(certsDir, file);
      if (fs.statSync(filePath).isFile()) {
        assets[`certs/${file}`] = fs.readFileSync(filePath, 'base64');
      }
    }
  }

  console.log(`   已打包 ${Object.keys(assets).length} 个资源文件`);

  // 2. 创建中间打包文件
  console.log('\n2️⃣  创建 SEA 配置...');

  const seaConfig = {
    main: path.join(ROOT, 'src', 'index.js'),
    output: path.join(ROOT, 'dist', 'model-proxy-blob.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };

  const seaConfigPath = path.join(ROOT, 'dist', 'sea-config.json');
  if (!fs.existsSync(path.join(ROOT, 'dist'))) {
    fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  }
  fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));

  console.log('   SEA 配置已创建');

  // 3. 生成 blob
  console.log('\n3️⃣  生成 blob...');
  try {
    execSync(`node --experimental-sea-config "${seaConfigPath}"`, {
      cwd: ROOT,
      stdio: 'inherit',
    });
    console.log('   ✅ Blob 生成成功');
  } catch (err) {
    console.error('   ❌ Blob 生成失败:', err.message);
    process.exit(1);
  }

  // 4. 复制 Node.js 可执行文件
  const platforms = [
    { name: 'win', ext: '.exe', node: process.execPath },
  ];

  // 检测当前平台
  const platformMap = {
    win32: { name: 'win', ext: '.exe' },
    linux: { name: 'linux', ext: '' },
    darwin: { name: 'macos', ext: '' },
  };

  const platform = platformMap[process.platform];
  if (!platform) {
    console.error(`❌ 不支持的平台: ${process.platform}`);
    process.exit(1);
  }

  const outputName = `model-proxy-${platform.name}-${process.arch}${platform.ext}`;
  const outputPath = path.join(ROOT, 'dist', outputName);

  console.log(`\n4️⃣  创建可执行文件: ${outputName}`);
  fs.copyFileSync(process.execPath, outputPath);

  // 5. 注入 blob
  console.log('\n5️⃣  注入 SEA blob...');
  try {
    const blobPath = seaConfig.output;
    if (process.platform === 'win32') {
      // Windows: 使用 npx postject
      const postjectCmd = `npx postject "${outputPath}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`;
      execSync(postjectCmd, { cwd: ROOT, stdio: 'inherit' });
    } else {
      // Linux/Mac: 使用 postject
      execSync(`npx postject "${outputPath}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`, {
        cwd: ROOT,
        stdio: 'inherit',
      });
    }
    console.log('   ✅ Blob 注入成功');
  } catch (err) {
    console.error('   ❌ Blob 注入失败:', err.message);
    console.error('   请确保已安装 postject: npm install -g postject');
    process.exit(1);
  }

  // 6. 签名（仅 Windows）
  if (process.platform === 'win32') {
    console.log('\n6️⃣  签名可执行文件（可选）...');
    try {
      // 尝试使用 signtool 签名（如果可用）
      execSync(`signtool sign /fd SHA256 "${outputPath}"`, { stdio: 'ignore' });
      console.log('   ✅ 已签名');
    } catch {
      console.log('   ⚠️  未找到 signtool，跳过签名（不影响使用）');
    }
  }

  console.log(`\n✅ 构建完成!`);
  console.log(`   输出路径: ${outputPath}`);
  console.log(`   文件大小: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)} MB`);
  console.log('');
  console.log('运行方式:');
  if (process.platform === 'win32') {
    console.log(`   ${outputPath}`);
  } else {
    console.log(`   ./${path.relative(ROOT, outputPath)}`);
  }
}

main().catch(console.error);

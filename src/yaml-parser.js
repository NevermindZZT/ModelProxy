/**
 * 简易 YAML 解析器
 * 仅支持本项目配置文件所需的 YAML 子集
 */
function parse(text) {
  const rawLines = text.split('\n');
  const lines = rawLines.map(l => l.replace(/#.*$/, '')); // 移除注释
  const result = {};
  const stack = [{ obj: result, indent: -1 }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // 缩进减少时回退
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const currentObj = stack[stack.length - 1].obj;

    // 处理数组项: - value
    if (trimmed.startsWith('- ')) {
      const value = parseValue(trimmed.substring(2));
      if (Array.isArray(currentObj)) {
        currentObj.push(value);
      }
      continue;
    }

    // 处理键值对
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.substring(0, colonIdx).trim().replace(/^["']|["']$/g, '');
    const valuePart = trimmed.substring(colonIdx + 1).trim();

    if (valuePart === '') {
      // 对象或数组开始 — 查看后续行判断
      let hasArrayItem = false;
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        if (nextLine.trim() === '' || nextLine.trim().startsWith('#')) continue;
        if (nextLine.search(/\S/) > indent && nextLine.trim().startsWith('- ')) {
          hasArrayItem = true;
        }
        break;
      }

      if (hasArrayItem) {
        const arr = [];
        currentObj[key] = arr;
        stack.push({ obj: arr, indent });
      } else {
        const newObj = {};
        currentObj[key] = newObj;
        stack.push({ obj: newObj, indent });
      }
    } else {
      currentObj[key] = parseValue(valuePart);
    }
  }

  return result;
}

function parseValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;

  // 数字
  const num = Number(value);
  if (!isNaN(num) && value !== '') return num;

  // 引号字符串
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

module.exports = { parse };

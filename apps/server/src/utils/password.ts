/**
 * 密码哈希：bcrypt（纯 JS 实现，避免 Windows 上原生编译依赖）。
 * 生产可平移到 argon2id，接口保持不变。
 * ⚠️ 仅做密码校验，不代表实名认证能力。
 */
import bcrypt from 'bcryptjs';

const COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

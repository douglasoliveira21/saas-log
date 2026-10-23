-- AlterTable
ALTER TABLE "users" ADD COLUMN     "nav_style" TEXT NOT NULL DEFAULT 'CLASSIC';


ALTER TABLE users ADD CONSTRAINT users_nav_style CHECK (nav_style IN ('CLASSIC', 'LAUNCHER'));

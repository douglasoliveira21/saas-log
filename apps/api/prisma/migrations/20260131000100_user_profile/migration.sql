-- AlterTable
ALTER TABLE "users" ADD COLUMN     "phone" TEXT;

-- CreateTable
CREATE TABLE "user_avatars" (
    "user_id" UUID NOT NULL,
    "content" BYTEA NOT NULL,
    "content_type" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_avatars_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "user_avatars" ADD CONSTRAINT "user_avatars_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Foto de perfil: por usuário (como users), acesso restrito na aplicação ao próprio usuário ou a colegas da mesma empresa.
GRANT SELECT, INSERT, UPDATE, DELETE ON user_avatars TO dh_app;

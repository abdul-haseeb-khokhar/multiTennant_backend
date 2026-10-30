-- AlterTable
ALTER TABLE "tenant_core"."platform_admins" ADD COLUMN     "tokens_valid_after" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tenant_core"."tenant_user" ADD COLUMN     "tokens_valid_after" TIMESTAMP(3);

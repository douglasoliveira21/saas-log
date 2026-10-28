-- AlterTable
ALTER TABLE "delivery_routes" ADD COLUMN     "plan_distance_m" INTEGER,
ADD COLUMN     "plan_duration_s" INTEGER,
ADD COLUMN     "plan_geometry" JSONB,
ADD COLUMN     "planned_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "delivery_stops" ADD COLUMN     "dest_lat" DECIMAL(9,6),
ADD COLUMN     "dest_lng" DECIMAL(9,6),
ADD COLUMN     "geocode_status" TEXT,
ADD COLUMN     "geocoded_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "establishments" ADD COLUMN     "geo_lat" DECIMAL(9,6),
ADD COLUMN     "geo_lng" DECIMAL(9,6),
ADD COLUMN     "geocoded_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "driver_positions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "route_id" UUID,
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "accuracy_m" INTEGER,
    "speed_mps" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "gps_enabled" BOOLEAN NOT NULL DEFAULT true,
    "permission" TEXT,
    "source" TEXT NOT NULL DEFAULT 'APP',
    "recorded_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_track_points" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "lat" DECIMAL(9,6) NOT NULL,
    "lng" DECIMAL(9,6) NOT NULL,
    "accuracy_m" INTEGER,
    "speed_mps" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "recorded_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_track_points_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_positions_tenant_id_driver_id_key" ON "driver_positions"("tenant_id", "driver_id");

-- CreateIndex
CREATE INDEX "driver_track_points_tenant_id_route_id_recorded_at_idx" ON "driver_track_points"("tenant_id", "route_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "driver_track_points_tenant_id_driver_id_recorded_at_key" ON "driver_track_points"("tenant_id", "driver_id", "recorded_at");

-- AddForeignKey
ALTER TABLE "driver_positions" ADD CONSTRAINT "driver_positions_tenant_id_driver_id_fkey" FOREIGN KEY ("tenant_id", "driver_id") REFERENCES "drivers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_track_points" ADD CONSTRAINT "driver_track_points_tenant_id_driver_id_fkey" FOREIGN KEY ("tenant_id", "driver_id") REFERENCES "drivers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Posição e trilha do motorista: por empresa (RLS) e valores válidos.
GRANT SELECT, INSERT, UPDATE, DELETE ON driver_positions, driver_track_points TO dh_app;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['driver_positions', 'driver_track_points'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
ALTER TABLE driver_positions ADD CONSTRAINT driver_positions_valid CHECK ((lat IS NULL OR lat BETWEEN -90 AND 90) AND (lng IS NULL OR lng BETWEEN -180 AND 180) AND source IN ('APP', 'WEB'));
ALTER TABLE driver_track_points ADD CONSTRAINT driver_track_points_valid CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180);
ALTER TABLE delivery_stops ADD CONSTRAINT delivery_stops_geocode CHECK (geocode_status IS NULL OR geocode_status IN ('OK', 'NOT_FOUND', 'ERROR'));

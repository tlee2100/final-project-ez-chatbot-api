import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  Exclusion,
} from 'typeorm';
import { AutoMap } from '@automapper/classes';
import { Site } from '../../site/entities/site.entity';
import { BookingResource } from '../../site/entities/booking-resources.entity';
import { BookingService as BookingServiceEntity } from '../../site/entities/booking-service.entity';
import { BookingStatus } from '../enums/booking-status.enum';

@Entity('bookings')
@Index('UQ_bookings_site_code', ['siteId', 'code'], { unique: true })
@Index('IDX_bookings_site_status_start', ['siteId', 'status', 'startAt'])
@Exclusion(
  'no_overlap',
  `USING gist ("siteId" WITH =, COALESCE("resourceId"::text, '___NULL___') WITH =, tstzrange("startAt", "endAt") WITH &&) WHERE (status <> 'cancelled')`,
)
export class Booking {
  @AutoMap()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @AutoMap()
  @Column({ type: 'varchar', length: 50 })
  code: string;

  @AutoMap()
  @Column({ type: 'uuid' })
  siteId: string;

  @ManyToOne(() => Site, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'siteId' })
  site: Site;

  @AutoMap(() => String)
  @Column({ type: 'uuid', nullable: true })
  resourceId: string | null;

  @ManyToOne(() => BookingResource, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'resourceId' })
  resource: BookingResource | null;

  @AutoMap(() => String)
  @Column({ type: 'uuid', nullable: true })
  serviceId: string | null;

  @ManyToOne(() => BookingServiceEntity, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'serviceId' })
  service: BookingServiceEntity | null;

  @AutoMap()
  @Column({ type: 'timestamptz' })
  startAt: Date;

  @AutoMap()
  @Column({ type: 'timestamptz' })
  endAt: Date;

  @AutoMap()
  @Column({ type: 'varchar', length: 50 })
  timezone: string;

  @AutoMap(() => String)
  @Column({
    type: 'enum',
    enum: BookingStatus,
    default: BookingStatus.CONFIRMED,
  })
  status: BookingStatus;

  @AutoMap()
  @Column({ type: 'varchar', length: 255 })
  customerName: string;

  @AutoMap()
  @Column({ type: 'varchar', length: 20 })
  phone: string;

  @AutoMap(() => String)
  @Column({ type: 'varchar', length: 255, nullable: true })
  customerEmail: string | null;

  @AutoMap(() => String)
  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @AutoMap(() => Object)
  @Column({ type: 'jsonb', default: '{}' })
  templateFields: Record<string, unknown>;

  @AutoMap()
  @CreateDateColumn()
  createdAt: Date;

  @AutoMap()
  @UpdateDateColumn()
  updatedAt: Date;
}

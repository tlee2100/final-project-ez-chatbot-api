import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AutoMap } from '@automapper/classes';
import { Site } from '../../site/entities/site.entity';
import { BookingResource } from '../../site/entities/booking-resources.entity';

@Entity('booking_blockouts')
@Index('IDX_booking_blockouts_site_start_end', ['siteId', 'startAt', 'endAt'])
@Index('IDX_booking_blockouts_resource', ['resourceId'])
export class BookingBlockout {
  @AutoMap()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @AutoMap()
  @Column({ type: 'uuid' })
  siteId: string;

  @ManyToOne(() => Site, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'siteId' })
  site: Site;

  @AutoMap(() => String)
  @Column({ type: 'uuid', nullable: true })
  resourceId: string | null;

  @ManyToOne(() => BookingResource, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'resourceId' })
  resource: BookingResource | null;

  @AutoMap()
  @Column({ type: 'timestamptz' })
  startAt: Date;

  @AutoMap()
  @Column({ type: 'timestamptz' })
  endAt: Date;

  @AutoMap(() => String)
  @Column({ type: 'varchar', length: 255, nullable: true })
  reason: string | null;

  @AutoMap()
  @CreateDateColumn()
  createdAt: Date;

  @AutoMap()
  @UpdateDateColumn()
  updatedAt: Date;
}

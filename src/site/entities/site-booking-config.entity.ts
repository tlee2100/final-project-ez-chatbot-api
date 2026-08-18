import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AutoMap } from '@automapper/classes';
import { Site } from './site.entity';

@Entity('site_booking_configs')
export class SiteBookingConfig {
  @AutoMap()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @AutoMap()
  @Column({ type: 'uuid' })
  siteId: string;

  @OneToOne(() => Site, (site) => site.bookingConfig, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'siteId' })
  site: Site;

  @AutoMap()
  @Column({ type: 'varchar', length: 50, nullable: true })
  bookingTimezone: string;

  @AutoMap()
  @Column({ type: 'int', default: 30 })
  bookingSlotDuration: number;

  @AutoMap()
  @Column({ type: 'varchar', length: 5, default: '09:00' })
  bookingStartTime: string;

  @AutoMap()
  @Column({ type: 'varchar', length: 5, default: '18:00' })
  bookingEndTime: string;

  @AutoMap(() => [Number])
  @Column({ type: 'int', array: true, default: '{1,2,3,4,5}' })
  bookingAvailableDays: number[];
}

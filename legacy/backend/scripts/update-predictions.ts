import { PrismaClient } from '@prisma/client';
import { spawn } from 'child_process';
import path from 'path';
import { calculateArtistPopularity } from '../src/utils/artistPopularity';

const prisma = new PrismaClient();

interface MlInput {
  artist_popularity: number;
  artist_city_popularity: number;
  venue_capacity: number;
  city: string;
  currency: string;
  venue_type?: string;
}

interface MlOutput {
  pricing_tiers: {
    vip: number;
    tier1: number;
    tier2: number;
    tier3: number;
  };
  avg_ticket_price: number;
  tickets_sold: number;
  total_revenue: number;
  demand_score: number;
  model_version: string;
  status: string;
  currency: string; // Always INR
}

async function updatePredictions() {
  try {
    console.log('Fetching artists and their concerts...');

    // Fetch all artists with their concerts (we'll consider all concerts for now)
    const artists = await prisma.artist.findMany({
      include: {
        concerts: true
      }
    });

    let totalConcerts = 0;
    let processedCount = 0;
    let errorCount = 0;

    for (const artist of artists) {
      for (const concert of artist.concerts) {
        totalConcerts++;

        const input: MlInput = {
          artist_popularity: await calculateArtistPopularity(artist),
          artist_city_popularity: concert.artistCityPopularity ? Number(concert.artistCityPopularity) : 50,
          venue_capacity: concert.capacity ? Number(concert.capacity) : 5000,
          city: concert.city,
          currency: concert.currency || 'INR',
          venue_type: undefined // We don't have venue_type in the Concert model, so we leave it undefined
        };

        // Convert input to JSON string for the Python script
        const inputJson = JSON.stringify(input);

        // Call the ML processor
        const processorPath = path.join(__dirname, '..', 'ml_engine', 'processor.py');
        const pythonProcess = spawn('python', [processorPath, inputJson]);

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        const result = await new Promise<{ output: MlOutput | null; error: string | null }>((resolve, reject) => {
          pythonProcess.on('close', (code) => {
            if (code !== 0) {
              resolve({ output: null, error: stderr || `Process exited with code ${code}` });
            } else {
              try {
                const output = JSON.parse(stdout.trim()) as MlOutput;
                resolve({ output, error: null });
              } catch (e) {
                resolve({ output: null, error: `Failed to parse JSON output: ${e}` });
              }
            }
          });
        });

        if (result.error) {
          console.error(`Error processing concert ${concert.id}:`, result.error);
          errorCount++;
          continue;
        }

        if (!result.output) {
          console.error(`No output for concert ${concert.id}`);
          errorCount++;
          continue;
        }

        const mlOutput = result.output;
        const concertUpdate = {
          ticketsSold: mlOutput.tickets_sold,
          avgTicketPrice: mlOutput.avg_ticket_price,
          totalRevenue: mlOutput.total_revenue,
          demandScore: mlOutput.demand_score
        };

        // Calculate sellout probability
        const selloutProbability = concert.capacity && concert.capacity > 0
          ? Math.min(0.99, mlOutput.tickets_sold / concert.capacity)
          : 0;

        // Create prediction output record
        await prisma.predictionOutput.create({
          data: {
            concertId: concert.id,
            modelVersion: mlOutput.model_version,
            input: {
              artist_popularity: input.artist_popularity,
              artist_city_popularity: input.artist_city_popularity,
              venue_capacity: input.venue_capacity,
              city: input.city,
              currency: input.currency
            },
            features: {
              artist_popularity: input.artist_popularity,
              artist_city_popularity: input.artist_city_popularity,
              venue_capacity: input.venue_capacity,
              city_market_boost: 0, // We'll compute this later if needed
            },
            expectedRevenue: mlOutput.total_revenue, // Already in INR
            expectedAttendance: mlOutput.tickets_sold,
            selloutProbability: Number(selloutProbability.toFixed(4)), // Ensure 4 decimal places
            demandScore: mlOutput.demand_score
          }
        });

        await prisma.concert.update({
          where: { id: concert.id },
          data: concertUpdate
        });

        processedCount++;

        if (processedCount % 50 === 0) {
          console.log(`Processed ${processedCount} concerts...`);
        }
      }
    }

    console.log(`\nFinished processing.`);
    console.log(`Total concerts: ${totalConcerts}`);
    console.log(`Successfully processed: ${processedCount}`);
    console.log(`Errors: ${errorCount}`);

  } catch (error) {
    console.error('Unexpected error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

updatePredictions();

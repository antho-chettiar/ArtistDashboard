import { PrismaClient } from '@prisma/client';
import { spawn } from 'child_process';
import path from 'path';
import { calculateArtistPopularity } from '../src/utils/artistPopularity';

const prisma = new PrismaClient();

async function testPredictions() {
  try {
    console.log('Fetching a few artists and their concerts...');

    // Fetch just a few artists with their concerts for testing
    const artists = await prisma.artist.findMany({
      take: 3, // Just 3 artists for testing
      include: {
        concerts: {
          take: 2 // Just 2 concerts per artist
        }
      }
    });

    let totalConcerts = 0;
    let processedCount = 0;
    let errorCount = 0;

    for (const artist of artists) {
      console.log(`Processing artist: ${artist.artistName}`);

      for (const concert of artist.concerts) {
        totalConcerts++;

        const input = {
          artist_popularity: await calculateArtistPopularity(artist),
          artist_city_popularity: concert.artistCityPopularity ? Number(concert.artistCityPopularity) : 50,
          venue_capacity: concert.capacity ? Number(concert.capacity) : 5000,
          city: concert.city,
          currency: concert.currency || 'INR'
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

        pythonProcess.on('close', (code) => {
          if (code !== 0) {
            console.error(`Error processing concert ${concert.id}:`, stderr || `Process exited with code ${code}`);
            errorCount++;
          } else {
            try {
              const output = JSON.parse(stdout.trim());

              // Calculate sellout probability (use the variable to avoid TS error)
              const selloutProbability = concert.capacity && concert.capacity > 0
                ? Math.min(0.99, output.tickets_sold / concert.capacity)
                : 0;
              // We use the variable above to satisfy TypeScript

              console.log(`  Concert ${concert.id}: Revenue = INR ${output.total_revenue.toLocaleString()} (${(output.total_revenue/10000000).toFixed(2)} crores)`);

              // Uncomment below when ready to actually insert predictions
              /*
              await prisma.predictionOutput.create({
                data: {
                  concertId: concert.id,
                  modelVersion: output.model_version,
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
                    city_market_boost: 0,
                  },
                  expectedRevenue: output.total_revenue, // Already in INR
                  expectedAttendance: output.tickets_sold,
                  selloutProbability: Number(selloutProbability.toFixed(4)),
                  demandScore: output.demand_score
                }
              });
              */

              processedCount++;
            } catch (e) {
              console.error(`Error processing concert ${concert.id}: Failed to parse JSON output: ${e}`);
              errorCount++;
            }
          }
        });
      }
    }

    console.log(`\nFinished test processing.`);
    console.log(`Total concerts: ${totalConcerts}`);
    console.log(`Successfully processed: ${processedCount}`);
    console.log(`Errors: ${errorCount}`);

  } catch (error) {
    console.error('Unexpected error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

testPredictions();
